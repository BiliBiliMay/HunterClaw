import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { spawn } from "node:child_process";

import { z } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";
import { AGENT_FS_ROOT, isPathWithinRoot } from "@/lib/db/client";
import type { FileAccessScope } from "@/lib/tools/fileTool";
import { resolveFilePath } from "@/lib/tools/fileTool";

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
]);
const ALLOWED_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "rg",
  "git",
  "sed",
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "branch",
  "ls-files",
]);

export const shellToolSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export type ShellToolArgs = z.infer<typeof shellToolSchema>;
export type ResolvedShellToolCwd = {
  requestedCwd: string;
  resolvedCwd: string;
  scope: FileAccessScope;
};

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

function assertNoPathEscape(tokens: string[]) {
  for (const token of tokens) {
    if (!token || token.startsWith("-")) {
      continue;
    }

    if (
      token === ".." ||
      token.startsWith("../") ||
      token.includes("/../") ||
      token.startsWith("/") ||
      token.startsWith("~")
    ) {
      throw new Error(`Blocked: path '${token}' escapes the configured shell directory.`);
    }
  }
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

  assertNoPathEscape(tokens.slice(1));

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

export function resolveShellToolCwd(inputCwd?: string): ResolvedShellToolCwd {
  const target = resolveFilePath(inputCwd ?? ".");

  return {
    requestedCwd: inputCwd ?? ".",
    resolvedCwd: target.resolvedPath,
    scope: target.scope,
  };
}

function normalizeExistingCwd(resolved: ResolvedShellToolCwd) {
  const realCwd = fs.realpathSync.native(resolved.resolvedCwd);
  const canonicalRoot = fs.realpathSync.native(AGENT_FS_ROOT);

  return {
    ...resolved,
    resolvedCwd: realCwd,
    scope: isPathWithinRoot(realCwd, canonicalRoot) ? "project" : "host",
  };
}

async function assertWorkingDirectory(resolved: ResolvedShellToolCwd) {
  let stats;

  try {
    stats = await fsPromises.stat(resolved.resolvedCwd);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Working directory does not exist: ${resolved.requestedCwd}`);
    }

    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved.requestedCwd}`);
  }

  return normalizeExistingCwd(resolved);
}

export function getShellToolRiskLevel(args: ShellToolArgs): RiskLevel {
  const resolved = resolveShellToolCwd(args.cwd);

  try {
    return normalizeExistingCwd(resolved).scope === "project" ? "low" : "medium";
  } catch {
    return resolved.scope === "project" ? "low" : "medium";
  }
}

async function runSpawn(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
  description: "Run a small allowlist of readonly shell commands from the configured root or an approved cwd.",
  schema: shellToolSchema,
  getRiskLevel(args: ShellToolArgs): RiskLevel {
    return getShellToolRiskLevel(args);
  },
  async execute(args: ShellToolArgs): Promise<JsonValue> {
    const target = await assertWorkingDirectory(resolveShellToolCwd(args.cwd));
    const validated = validateCommand(args.command);
    const result = await runSpawn(validated.executable, validated.args, target.resolvedCwd);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Shell command exited with code ${result.exitCode}.`);
    }

    return {
      command: validated.command,
      cwd: target.requestedCwd,
      resolvedCwd: target.resolvedCwd,
      scope: target.scope,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
      exitCode: result.exitCode,
    };
  },
};
