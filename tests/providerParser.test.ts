import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { getApiModelForRole } from "@/lib/llm/apiProvider";
import { parseDecisionResponse } from "@/lib/llm/decisionParser";
import {
  getConfiguredRuntimeLabels,
  getConfiguredProviderName,
  getDefaultProvider,
  getExecutorModelLabel,
  getExecutorProvider,
  getPlannerModelLabel,
} from "@/lib/llm/resolveProvider";

import { createTestHarness } from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-provider-parser");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

test("resolveProvider falls back to api and recognizes codex with whitespace and mixed casing", () => {
  harness.setEnv("LLM_PROVIDER");
  assert.equal(getConfiguredProviderName(), "api");
  assert.equal(getDefaultProvider().name, "api");
  assert.equal(getExecutorProvider().name, "api");

  harness.setEnv("LLM_PROVIDER", "");
  assert.equal(getConfiguredProviderName(), "api");

  harness.setEnv("LLM_PROVIDER", "unsupported-provider");
  assert.equal(getConfiguredProviderName(), "api");

  harness.setEnv("LLM_PROVIDER", "  CoDeX  ");
  assert.equal(getConfiguredProviderName(), "codex");
  assert.equal(getDefaultProvider().name, "codex");
  assert.equal(getExecutorProvider().name, "api");
});

test("executor model resolution defaults to qwen3.5-plus and planner keeps the global model path", () => {
  harness.setEnv("LLM_API_MODEL");
  harness.setEnv("OPENAI_MODEL");
  harness.setEnv("LLM_API_MODEL_EXECUTOR");

  assert.equal(getApiModelForRole("planner"), "gpt-5.4");
  assert.equal(getApiModelForRole("executor"), "qwen3.5-plus");

  harness.setEnv("LLM_API_MODEL", "planner-model");
  harness.setEnv("OPENAI_MODEL", "fallback-model");
  assert.equal(getApiModelForRole("planner"), "planner-model");
  assert.equal(getApiModelForRole("executor"), "qwen3.5-plus");

  harness.setEnv("LLM_API_MODEL_EXECUTOR", "custom-executor-model");
  assert.equal(getApiModelForRole("executor"), "custom-executor-model");
});

test("runtime labels reflect the configured planner and executor runtimes", () => {
  harness.setEnv("LLM_PROVIDER");
  harness.setEnv("LLM_API_MODEL");
  harness.setEnv("OPENAI_MODEL");
  harness.setEnv("LLM_API_MODEL_EXECUTOR");

  assert.deepEqual(getConfiguredRuntimeLabels(), {
    plannerModelLabel: "gpt-5.4",
    executorModelLabel: "qwen3.5-plus",
  });

  harness.setEnv("LLM_API_MODEL", "planner-model");
  harness.setEnv("LLM_API_MODEL_EXECUTOR", "executor-model");
  assert.equal(getPlannerModelLabel(), "planner-model");
  assert.equal(getExecutorModelLabel(), "executor-model");

  harness.setEnv("LLM_PROVIDER", "codex");
  assert.equal(getPlannerModelLabel(), "Codex (model unavailable)");
  assert.equal(getExecutorModelLabel(), "executor-model");
});

test("parseDecisionResponse supports direct JSON respond payloads", () => {
  const decision = parseDecisionResponse(JSON.stringify({
    type: "respond",
    reason: "Ready to answer.",
  }));

  assert.deepEqual(decision, {
    type: "respond",
    reason: "Ready to answer.",
  });
});

test("parseDecisionResponse handles fenced JSON tool calls and shell aliases", () => {
  const decision = parseDecisionResponse([
    "```json",
    JSON.stringify({
      type: "tool",
      tool: "bash",
      arguments: JSON.stringify({
        command: "pwd",
      }),
      reason: "Inspect the workspace.",
    }),
    "```",
  ].join("\n"));

  assert.deepEqual(decision, {
    type: "tool_call",
    toolName: "shellTool",
    args: {
      command: "pwd",
    },
    reason: "Inspect the workspace.",
  });
});

test("parseDecisionResponse preserves shell cwd arguments", () => {
  const decision = parseDecisionResponse(JSON.stringify({
    type: "tool_call",
    toolName: "shellTool",
    args: {
      command: "git status",
      cwd: "/Users/example/project",
    },
    reason: "Inspect the external project.",
  }));

  assert.deepEqual(decision, {
    type: "tool_call",
    toolName: "shellTool",
    args: {
      command: "git status",
      cwd: "/Users/example/project",
    },
    reason: "Inspect the external project.",
  });
});

test("parseDecisionResponse handles nested payloads and the code alias", () => {
  const decision = parseDecisionResponse(JSON.stringify({
    decision: {
      type: "tool_use",
      toolName: "code",
      parameters: {
        action: "createFile",
        path: "src/example.ts",
        content: "export const value = 1;\n",
      },
      reason: "Create the requested file.",
    },
  }));

  assert.deepEqual(decision, {
    type: "tool_call",
    toolName: "codeTool",
    args: {
      action: "createFile",
      path: "src/example.ts",
      content: "export const value = 1;\n",
    },
    reason: "Create the requested file.",
  });
});

test("parseDecisionResponse handles nested function calls and the browser alias", () => {
  const decision = parseDecisionResponse(JSON.stringify({
    result: {
      data: {
        function_call: {
          name: "browser",
          arguments: JSON.stringify({
            action: "openPage",
            url: "https://example.com",
          }),
        },
        reason: "Open the page before answering.",
      },
    },
  }));

  assert.deepEqual(decision, {
    type: "tool_call",
    toolName: "browserTool",
    args: {
      action: "openPage",
      url: "https://example.com",
    },
    reason: "Open the page before answering.",
  });
});

test("parseDecisionResponse supports planner delegate payloads", () => {
  const decision = parseDecisionResponse(JSON.stringify({
    type: "delegate",
    task: "Inspect the repo, implement the fix, and verify it.",
    successCriteria: "The bug is fixed and tests pass.",
    notes: "Keep changes scoped to the current issue.",
    reason: "This needs multiple dependent tool steps.",
  }));

  assert.deepEqual(decision, {
    type: "delegate",
    task: "Inspect the repo, implement the fix, and verify it.",
    successCriteria: "The bug is fixed and tests pass.",
    notes: "Keep changes scoped to the current issue.",
    reason: "This needs multiple dependent tool steps.",
  });
});

test("parseDecisionResponse prefers tool calls from arrays and supports the file alias", () => {
  const decision = parseDecisionResponse(JSON.stringify([
    {
      type: "message",
      content: "Thinking through the next step.",
    },
    {
      type: "tool_use",
      name: "file",
      args: {
        action: "readFile",
        path: "README.md",
      },
      reason: "Read the project instructions.",
    },
  ]));

  assert.deepEqual(decision, {
    type: "tool_call",
    toolName: "fileTool",
    args: {
      action: "readFile",
      path: "README.md",
    },
    reason: "Read the project instructions.",
  });
});

test("parseDecisionResponse falls back to respond for plain text output", () => {
  const decision = parseDecisionResponse("I can answer this without using another tool.");

  assert.deepEqual(decision, {
    type: "respond",
    reason: "Ready to answer without another tool.",
  });
});

test("parseDecisionResponse rejects empty and uninterpretable payloads", () => {
  assert.throws(
    () => parseDecisionResponse("   "),
    /The model returned an empty response/,
  );
  assert.throws(
    () =>
      parseDecisionResponse(JSON.stringify({
        status: "ok",
      })),
    /could not interpret as a message or tool call/,
  );
});
