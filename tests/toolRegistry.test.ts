import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { getToolDefinition, validateToolCall } from "@/lib/tools/registry";

import { createTestHarness } from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-tool-registry");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

test("getToolDefinition returns registered tools and rejects unknown names", () => {
  assert.equal(getToolDefinition("fileTool").name, "fileTool");
  assert.equal(getToolDefinition("codeTool").name, "codeTool");
  assert.equal(getToolDefinition("shellTool").name, "shellTool");
  assert.equal(getToolDefinition("browserTool").name, "browserTool");
  assert.throws(() => getToolDefinition("missingTool"), /Unknown tool: missingTool/);
});

test("validateToolCall accepts valid arguments and applies schema defaults", () => {
  const fileValidation = validateToolCall("fileTool", {
    action: "listDirectory",
  });
  const codeValidation = validateToolCall("codeTool", {
    action: "createFile",
    path: "src/example.ts",
    content: "export const value = 1;\n",
  });
  const shellValidation = validateToolCall("shellTool", {
    command: "pwd",
  });
  const browserValidation = validateToolCall("browserTool", {
    action: "openPage",
    url: "https://example.com",
  });

  assert.deepEqual(fileValidation.parsedArgs, {
    action: "listDirectory",
    path: ".",
  });
  assert.equal(fileValidation.tool.name, "fileTool");
  assert.equal(codeValidation.tool.name, "codeTool");
  assert.equal(shellValidation.tool.name, "shellTool");
  assert.equal(browserValidation.tool.name, "browserTool");
});

test("validateToolCall rejects malformed tool arguments", () => {
  assert.throws(() =>
    validateToolCall("fileTool", {
      action: "readFile",
    }),
  );
  assert.throws(() =>
    validateToolCall("codeTool", {
      action: "applyPatch",
      patch: "",
    }),
  );
  assert.throws(() =>
    validateToolCall("shellTool", {
      command: "",
    }),
  );
  assert.throws(() =>
    validateToolCall("browserTool", {
      action: "openPage",
      url: "not-a-url",
    }),
  );
});
