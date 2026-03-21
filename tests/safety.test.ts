import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { evaluateToolSafety } from "@/lib/agent/safety";

import { createTestHarness } from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-safety");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

test("low-risk actions auto-run by default", async () => {
  const safety = await evaluateToolSafety("shellTool", { command: "pwd" }, "low");

  assert.deepEqual(safety, {
    riskLevel: "low",
    requiresApproval: false,
  });
});

test("medium and high risk actions require approval by default", async () => {
  const mediumSafety = await evaluateToolSafety("codeTool", { action: "createFile" }, "medium");
  const highSafety = await evaluateToolSafety("codeTool", { action: "createFile" }, "high");

  assert.equal(mediumSafety.requiresApproval, true);
  assert.equal(highSafety.requiresApproval, true);
});

test("file writes auto-approve when the stored preference is enabled", async () => {
  await harness.setPreference("autoApproveFileWrites", "true");

  const safety = await evaluateToolSafety(
    "fileTool",
    {
      action: "writeFile",
      path: "notes.txt",
      content: "hello",
    },
    "medium",
  );

  assert.equal(safety.requiresApproval, false);
});

test("file writes auto-approve when the environment override is enabled", async () => {
  harness.setEnv("AUTO_APPROVE_FILE_WRITES", "true");

  const safety = await evaluateToolSafety(
    "fileTool",
    {
      action: "writeFile",
      path: "notes.txt",
      content: "hello",
    },
    "medium",
  );

  assert.equal(safety.requiresApproval, false);
});

test("interactive browser actions always require approval", async () => {
  const clickSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "click",
      selector: "button",
    },
    "low",
  );
  const typeSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "type",
      selector: "input",
      text: "hunterclaw",
    },
    "low",
  );

  assert.equal(clickSafety.requiresApproval, true);
  assert.equal(typeSafety.requiresApproval, true);
});

test("non-interactive browser actions only respect the provided risk level", async () => {
  const lowRiskSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "openPage",
      url: "https://example.com",
    },
    "low",
  );
  const mediumRiskSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "openPage",
      url: "https://example.com",
    },
    "medium",
  );

  assert.equal(lowRiskSafety.requiresApproval, false);
  assert.equal(mediumRiskSafety.requiresApproval, true);
});
