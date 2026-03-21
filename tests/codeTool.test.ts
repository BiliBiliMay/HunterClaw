import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createTwoFilesPatch } from "diff";

import {
  createApprovalRequest,
  finishToolExecution,
  getApprovalRequest,
  getHistoryPayload,
  logToolExecutionStart,
} from "@/lib/agent/memory";
import type { ToolResult } from "@/lib/agent/types";
import { reinitializeDbClientForTests } from "@/lib/db/client";
import { formatRecentToolExecutions } from "@/lib/llm/apiProvider";
import {
  codeTool,
  getCodeToolRiskLevel,
  prepareCodeToolOperation,
} from "@/lib/tools/codeTool";

let tempRoot = "";
let fsRoot = "";
let dbPath = "";

function createConversationId(label: string) {
  return `test-${label}-${crypto.randomUUID()}`;
}

async function writeWorkspaceFile(relativePath: string, content: string) {
  const absolutePath = path.join(fsRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hunterclaw-tests-"));
  fsRoot = path.join(tempRoot, "workspace");
  dbPath = path.join(tempRoot, "agent.db");

  reinitializeDbClientForTests({
    nextDbPath: dbPath,
    nextFsRoot: fsRoot,
  });
});

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("createFile writes a new file and generates a preview snapshot", async () => {
  const args = {
    action: "createFile" as const,
    path: "src/new-file.ts",
    content: "export const greeting = 'hello';\n",
  };

  const prepared = await prepareCodeToolOperation(args);
  const result = await codeTool.execute(args);
  const writtenFile = await fs.readFile(path.join(fsRoot, args.path), "utf8");

  assert.equal(getCodeToolRiskLevel(args), "medium");
  assert.equal(prepared.presentation.path, args.path);
  assert.equal(prepared.presentation.language, "typescript");
  assert.equal(prepared.presentation.beforeSnippet, null);
  assert.equal(prepared.presentation.afterSnippet, args.content);
  assert.equal(prepared.presentation.truncated, false);
  assert.deepEqual(result, {
    action: "createFile",
    path: "src/new-file.ts",
    resolvedPath: path.join(fsRoot, "src/new-file.ts"),
    scope: "project",
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
    additions: 1,
    deletions: 0,
  });
  assert.equal(writtenFile, args.content);
});

test("createFile rejects an existing file", async () => {
  await writeWorkspaceFile("src/existing.ts", "export const existing = true;\n");

  await assert.rejects(
    prepareCodeToolOperation({
      action: "createFile",
      path: "src/existing.ts",
      content: "export const existing = false;\n",
    }),
    /File already exists/,
  );
});

test("createFile marks absolute paths outside the workspace as high risk", () => {
  const outsidePath = path.join(tempRoot, "..", `outside-${crypto.randomUUID()}.ts`);

  assert.equal(
    getCodeToolRiskLevel({
      action: "createFile",
      path: outsidePath,
      content: "export const outside = true;\n",
    }),
    "high",
  );
});

test("applyPatch updates an existing file and computes diff stats", async () => {
  const relativePath = "src/patched.ts";
  const beforeContent = "export const value = 1;\n";
  const afterContent = "export const value = 2;\nexport const added = true;\n";
  await writeWorkspaceFile(relativePath, beforeContent);

  const patch = createTwoFilesPatch(relativePath, relativePath, beforeContent, afterContent);
  const prepared = await prepareCodeToolOperation({
    action: "applyPatch",
    patch,
  });
  const result = await codeTool.execute({
    action: "applyPatch",
    patch,
  });
  const writtenFile = await fs.readFile(path.join(fsRoot, relativePath), "utf8");

  assert.equal(prepared.presentation.path, relativePath);
  assert.equal(prepared.presentation.beforeSnippet, beforeContent);
  assert.equal(prepared.presentation.afterSnippet, afterContent);
  assert.equal(prepared.presentation.stats.additions, 2);
  assert.equal(prepared.presentation.stats.deletions, 1);
  assert.deepEqual(result, {
    action: "applyPatch",
    path: relativePath,
    resolvedPath: path.join(fsRoot, relativePath),
    scope: "project",
    bytesWritten: Buffer.byteLength(afterContent, "utf8"),
    additions: 2,
    deletions: 1,
  });
  assert.equal(writtenFile, afterContent);
});

test("applyPatch rejects malformed, multi-file, rename, delete, and binary patches", async () => {
  await writeWorkspaceFile("src/one.ts", "export const one = 1;\n");
  await writeWorkspaceFile("src/two.ts", "export const two = 2;\n");

  const multiFilePatch = [
    createTwoFilesPatch("src/one.ts", "src/one.ts", "export const one = 1;\n", "export const one = 3;\n"),
    createTwoFilesPatch("src/two.ts", "src/two.ts", "export const two = 2;\n", "export const two = 4;\n"),
  ].join("\n");

  await assert.rejects(
    prepareCodeToolOperation({
      action: "applyPatch",
      patch: "not a unified diff",
    }),
    /Patch must target exactly one file|Patch must contain at least one hunk/,
  );
  await assert.rejects(
    prepareCodeToolOperation({
      action: "applyPatch",
      patch: multiFilePatch,
    }),
    /Patch must target exactly one file/,
  );
  await assert.rejects(
    prepareCodeToolOperation({
      action: "applyPatch",
      patch: createTwoFilesPatch("src/one.ts", "src/renamed.ts", "export const one = 1;\n", "export const one = 2;\n"),
    }),
    /rename operations are not supported/,
  );
  await assert.rejects(
    prepareCodeToolOperation({
      action: "applyPatch",
      patch: [
        "--- src/one.ts",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-export const one = 1;",
      ].join("\n"),
    }),
    /not supported. Use createFile for new files/,
  );
  await assert.rejects(
    prepareCodeToolOperation({
      action: "applyPatch",
      patch: "GIT binary patch\nliteral 0",
    }),
    /Binary patches are not supported/,
  );
});

test("approval and tool history keep the same code preview snapshot", async () => {
  const conversationId = createConversationId("snapshot");
  const relativePath = "src/history.ts";
  const beforeContent = "export const snapshot = 1;\n";
  const afterContent = "export const snapshot = 2;\n";
  await writeWorkspaceFile(relativePath, beforeContent);

  const patch = createTwoFilesPatch(relativePath, relativePath, beforeContent, afterContent);
  const prepared = await prepareCodeToolOperation({
    action: "applyPatch",
    patch,
  });

  const approval = await createApprovalRequest({
    conversationId,
    sourceMessageId: null,
    toolName: "codeTool",
    args: {
      action: "applyPatch",
      patch,
    },
    presentation: prepared.presentation,
    riskLevel: "medium",
    reason: "Apply the requested patch.",
  });
  const storedApproval = await getApprovalRequest(approval.id);
  const execution = await logToolExecutionStart({
    conversationId,
    toolName: "codeTool",
    args: {
      action: "applyPatch",
      patch,
    },
    presentation: prepared.presentation,
    riskLevel: "medium",
  });
  const toolResult: ToolResult = {
    toolName: "codeTool",
    args: {
      action: "applyPatch",
      patch,
    },
    riskLevel: "medium",
    status: "success",
    output: {
      action: "applyPatch",
      path: relativePath,
    },
    error: null,
  };
  await finishToolExecution(execution.id, toolResult, prepared.presentation);

  const history = await getHistoryPayload(conversationId);

  assert.deepEqual(storedApproval?.presentation, prepared.presentation);
  assert.deepEqual(history.pendingApprovals[0]?.details, prepared.presentation);
  assert.deepEqual(history.toolExecutions[0]?.details, prepared.presentation);
});

test("provider formatting stays compact and excludes before/after snippets", async () => {
  const conversationId = createConversationId("provider");
  const relativePath = "src/provider.ts";
  const beforeContent = "export const provider = 1;\n";
  const afterContent = "export const provider = 2;\nexport const hidden = 'snippet';\n";
  await writeWorkspaceFile(relativePath, beforeContent);

  const patch = createTwoFilesPatch(relativePath, relativePath, beforeContent, afterContent);
  const prepared = await prepareCodeToolOperation({
    action: "applyPatch",
    patch,
  });
  const execution = await logToolExecutionStart({
    conversationId,
    toolName: "codeTool",
    args: {
      action: "applyPatch",
      patch,
    },
    presentation: prepared.presentation,
    riskLevel: "medium",
  });
  const storedExecution = await finishToolExecution(
    execution.id,
    {
      toolName: "codeTool",
      args: {
        action: "applyPatch",
        patch,
      },
      riskLevel: "medium",
      status: "success",
      output: {
        action: "applyPatch",
        path: relativePath,
        additions: prepared.presentation.stats.additions,
        deletions: prepared.presentation.stats.deletions,
      },
      error: null,
    },
    prepared.presentation,
  );

  assert.ok(storedExecution);

  const formatted = formatRecentToolExecutions([storedExecution]);

  assert.match(formatted, /TOOL: codeTool/);
  assert.match(formatted, /"path":"src\/provider.ts"/);
  assert.doesNotMatch(formatted, /export const hidden = 'snippet';/);
  assert.doesNotMatch(formatted, /Before/);
});
