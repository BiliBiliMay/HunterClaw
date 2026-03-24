import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createTwoFilesPatch } from "diff";

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
  await harness.setPreference("approval.file.project.write", "true");

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

test("stored false overrides the legacy file write environment fallback", async () => {
  harness.setEnv("AUTO_APPROVE_FILE_WRITES", "true");
  await harness.setPreference("approval.file.project.write", "false");

  const safety = await evaluateToolSafety(
    "fileTool",
    {
      action: "writeFile",
      path: "notes.txt",
      content: "hello",
    },
    "medium",
  );

  assert.equal(safety.requiresApproval, true);
});

test("off-root file reads and lists can auto-approve through stored preferences", async () => {
  const hostFile = await harness.writeHostFile("external/readme.txt", "host content\n");
  const hostDir = await harness.createHostDirectory("external/listing");
  await harness.setPreference("approval.file.host.read", "true");
  await harness.setPreference("approval.file.host.list", "true");

  const readSafety = await evaluateToolSafety(
    "fileTool",
    {
      action: "readFile",
      path: hostFile,
    },
    "medium",
  );
  const listSafety = await evaluateToolSafety(
    "fileTool",
    {
      action: "listDirectory",
      path: hostDir,
    },
    "medium",
  );

  assert.equal(readSafety.requiresApproval, false);
  assert.equal(listSafety.requiresApproval, false);
});

test("off-root file writes can auto-approve through stored preferences", async () => {
  const hostDir = await harness.createHostDirectory("external-write");
  await harness.setPreference("approval.file.host.write", "true");

  const safety = await evaluateToolSafety(
    "fileTool",
    {
      action: "writeFile",
      path: `${hostDir}/notes.txt`,
      content: "hello",
    },
    "high",
  );

  assert.equal(safety.requiresApproval, false);
});

test("project code creation and patching can auto-approve through stored preferences", async () => {
  await harness.writeWorkspaceFile("drafts/project-patch.txt", "before\n");
  await harness.setPreference("approval.code.project.create", "true");
  await harness.setPreference("approval.code.project.patch", "true");

  const createSafety = await evaluateToolSafety(
    "codeTool",
    {
      action: "createFile",
      path: "drafts/project-create.txt",
      content: "created\n",
    },
    "medium",
  );
  const patchSafety = await evaluateToolSafety(
    "codeTool",
    {
      action: "applyPatch",
      patch: createTwoFilesPatch(
        "drafts/project-patch.txt",
        "drafts/project-patch.txt",
        "before\n",
        "after\n",
        "",
        "",
        { context: 3 },
      ),
    },
    "medium",
  );

  assert.equal(createSafety.requiresApproval, false);
  assert.equal(patchSafety.requiresApproval, false);
});

test("off-root code creation and patching can auto-approve through stored preferences", async () => {
  const hostFile = await harness.writeHostFile("external-code/patch.txt", "before\n");
  await harness.setPreference("approval.code.host.create", "true");
  await harness.setPreference("approval.code.host.patch", "true");

  const createSafety = await evaluateToolSafety(
    "codeTool",
    {
      action: "createFile",
      path: `${harness.tempRoot}/external-code/create.txt`,
      content: "created\n",
    },
    "high",
  );
  const patchSafety = await evaluateToolSafety(
    "codeTool",
    {
      action: "applyPatch",
      patch: createTwoFilesPatch(
        hostFile,
        hostFile,
        "before\n",
        "after\n",
        "",
        "",
        { context: 3 },
      ),
    },
    "high",
  );

  assert.equal(createSafety.requiresApproval, false);
  assert.equal(patchSafety.requiresApproval, false);
});

test("off-root shell access can auto-approve through stored preferences", async () => {
  const hostDir = await harness.createHostDirectory("external-shell");
  await harness.setPreference("approval.shell.host.cwd", "true");

  const safety = await evaluateToolSafety(
    "shellTool",
    {
      command: "pwd",
      cwd: hostDir,
    },
    "medium",
  );

  assert.equal(safety.requiresApproval, false);
});

test("interactive browser actions respect granular stored preferences", async () => {
  await harness.setPreference("approval.browser.click", "true");
  await harness.setPreference("approval.browser.type", "true");

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

  assert.equal(clickSafety.requiresApproval, false);
  assert.equal(typeSafety.requiresApproval, false);
});

test("interactive browser actions still require approval by default", async () => {
  await harness.setPreference("approval.browser.click", "false");
  await harness.setPreference("approval.browser.type", "false");

  const clickSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "click",
      selector: "button",
    },
    "medium",
  );
  const typeSafety = await evaluateToolSafety(
    "browserTool",
    {
      action: "type",
      selector: "input",
      text: "hunterclaw",
    },
    "medium",
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
