import { spawn } from "node:child_process";

import { z } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";
import { WORKSPACE_ROOT } from "@/lib/db/client";

const BLOCKED_OPERATOR_PATTERN = /[|><;&`]/;
const BLOCKED_FRAGMENT_PATTERN = /\$\(|\n|\r/;
const BLOCKED_COMMAND_WORDS = new Set([
  "rm",
  "mv",
  "cp",
  "sudo",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "kill",
  "pkill",
  "dd",
  "mkfs",
  "truncate",
  "python",
  "python3",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);
const ALLOWED_COMMANDS = new Set(["pwd", "ls", "find", "cat", "head", "tail", "wc", "echo", "rg", "git"]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "branch"]);

export const shellToolSchema = z.object({
  command: z.string().min(1),
});

export type ShellToolArgs = z.infer<typeof shellToolSchema>;

function stripQuotes(token: string) {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }

  return token;
}

function tokenizeCommand(command: string) {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g);
  return (matches ?? []).map(stripQuotes);
}

function validateCommand(command: string) {
  const trimmedCommand = command.trim();

  if (BLOCKED_OPERATOR_PATTERN.test(trimmedCommand) || BLOCKED_FRAGMENT_PATTERN.test(trimmedCommand)) {
    throw new Error("Blocked: shell operators and chained commands are not allowed.");
  }

  // Keep parsing intentionally small and shell-free so execution stays predictable.
  const tokens = tokenizeCommand(trimmedCommand);
  if (tokens.length === 0) {
    throw new Error("Blocked: empty shell commands are not allowed.");
  }

  const executable = tokens[0];
  if (!ALLOWED_COMMANDS.has(executable)) {
    throw new Error(`Blocked: '${executable}' is not in the safe command allowlist.`);
  }

  for (const token of tokens) {
    if (BLOCKED_COMMAND_WORDS.has(token)) {
      throw new Error(`Blocked: '${token}' is not allowed in shell commands.`);
    }
  }

  if (executable === "git") {
    const subcommand = tokens[1];

    if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error("Blocked: only readonly git subcommands are allowed.");
    }
  }

  return {
    executable,
    args: tokens.slice(1),
    command: trimmedCommand,
  };
}

async function runSpawn(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Shell command timed out after 10 seconds."));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 0,
      });
    });
  });
}

export const shellTool = {
  name: "shellTool",
  description: "Run a small allowlist of readonly shell commands inside the workspace.",
  schema: shellToolSchema,
  getRiskLevel(_args: ShellToolArgs): RiskLevel {
    return "low";
  },
  async execute(args: ShellToolArgs): Promise<JsonValue> {
    const validated = validateCommand(args.command);
    const result = await runSpawn(validated.executable, validated.args);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Shell command exited with code ${result.exitCode}.`);
    }

    return {
      command: validated.command,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
      exitCode: result.exitCode,
    };
  },
};
