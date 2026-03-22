import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { evaluateToolSafety } from "@/lib/agent/safety";
import {
  getShellToolRiskLevel,
  resolveShellToolCwd,
  shellTool,
  shellToolSchema,
} from "@/lib/tools/shellTool";
import { createTestHarness } from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-shell-tool");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

test("shellTool schema keeps legacy command-only calls valid", () => {
  const parsedArgs = shellToolSchema.parse({
    command: "pwd",
  });

  assert.deepEqual(parsedArgs, {
    command: "pwd",
  });
});

test("shellTool risk is low inside the primary root and medium outside it", async () => {
  const hostDir = await harness.createHostDirectory("external-project");

  assert.equal(getShellToolRiskLevel({ command: "pwd" }), "low");
  assert.equal(getShellToolRiskLevel({ command: "pwd", cwd: "docs" }), "low");
  assert.equal(getShellToolRiskLevel({ command: "pwd", cwd: hostDir }), "medium");
});

test("off-root shell access requires approval", async () => {
  const hostDir = await harness.createHostDirectory("external-approval");
  const safety = await evaluateToolSafety(
    "shellTool",
    {
      command: "pwd",
      cwd: hostDir,
    },
    getShellToolRiskLevel({
      command: "pwd",
      cwd: hostDir,
    }),
  );

  assert.equal(safety.requiresApproval, true);
});

test("shellTool resolves relative and absolute cwd values", async () => {
  await harness.writeWorkspaceFile("docs/notes.txt", "note\n");
  const hostDir = await harness.createHostDirectory("external-root");
  const resolvedDocsDir = await fs.realpath(path.join(harness.fsRoot, "docs"));
  const resolvedHostDir = await fs.realpath(hostDir);

  const relativeResult = await shellTool.execute({
    command: "pwd",
    cwd: "docs",
  });
  const absoluteResult = await shellTool.execute({
    command: "pwd",
    cwd: hostDir,
  });

  assert.deepEqual(relativeResult, {
    command: "pwd",
    cwd: "docs",
    resolvedCwd: resolvedDocsDir,
    scope: "project",
    stdout: resolvedDocsDir,
    stderr: "",
    exitCode: 0,
  });
  assert.deepEqual(absoluteResult, {
    command: "pwd",
    cwd: hostDir,
    resolvedCwd: resolvedHostDir,
    scope: "host",
    stdout: resolvedHostDir,
    stderr: "",
    exitCode: 0,
  });
});

test("shellTool resolves tilde cwd values", async () => {
  const result = await shellTool.execute({
    command: "pwd",
    cwd: "~",
  }) as {
    cwd: string;
    resolvedCwd: string;
    stdout: string;
    scope: string;
  };

  assert.equal(result.cwd, "~");
  assert.equal(result.resolvedCwd, os.homedir());
  assert.equal(result.stdout, os.homedir());
  assert.equal(result.scope, "host");
});

test("shellTool rejects missing or non-directory cwd targets", async () => {
  const filePath = await harness.writeWorkspaceFile("docs/file.txt", "hello\n");

  await assert.rejects(
    shellTool.execute({
      command: "pwd",
      cwd: "missing-directory",
    }),
    /Working directory does not exist/,
  );
  await assert.rejects(
    shellTool.execute({
      command: "pwd",
      cwd: filePath,
    }),
    /Working directory is not a directory/,
  );
});

test("shellTool blocks command paths that escape the configured cwd", async () => {
  const hostDir = await harness.createHostDirectory("external-escape");

  await assert.rejects(
    shellTool.execute({
      command: "cat ../secret.txt",
      cwd: hostDir,
    }),
    /escapes the configured shell directory/,
  );
  await assert.rejects(
    shellTool.execute({
      command: "cat /etc/passwd",
      cwd: hostDir,
    }),
    /escapes the configured shell directory/,
  );
});

test("resolveShellToolCwd defaults to the configured primary root", () => {
  const resolved = resolveShellToolCwd();

  assert.equal(resolved.requestedCwd, ".");
  assert.equal(resolved.resolvedCwd, harness.fsRoot);
  assert.equal(resolved.scope, "project");
});
