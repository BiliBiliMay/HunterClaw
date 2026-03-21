import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { ChatStreamEvent } from "@/lib/agent/types";
import {
  handleApprovalDecision,
  runAgentTurn,
  streamAgentTurn,
  streamApprovalDecision,
} from "@/lib/agent/loop";

import {
  createConversationId,
  createDecisionResult,
  createFakeProvider,
  createResponseResult,
  createTestHarness,
  createUsage,
} from "@/tests/testHarness";

const harness = createTestHarness("hunterclaw-agent-loop");

before(async () => {
  await harness.setup();
});

after(async () => {
  await harness.teardown();
});

function getEventTypes(events: ChatStreamEvent[]) {
  return events.map((event) => event.type);
}

test("runAgentTurn completes a respond-only turn", async () => {
  const conversationId = createConversationId("respond-only");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "respond",
        reason: "No tool is needed.",
      }),
    ],
    responses: [
      (context) => {
        assert.equal(context.latestUserMessage, "Explain the repo.");
        return createResponseResult("Here is the explanation.");
      },
    ],
  });

  const response = await runAgentTurn({
    message: "Explain the repo.",
    conversationId,
    provider,
  });

  assert.equal(response.status, "completed");
  assert.equal(provider.calls.plan.length, 1);
  assert.equal(provider.calls.respond.length, 1);
  assert.equal(response.messages.length, 2);
  assert.equal(response.messages[1]?.content, "Here is the explanation.");
  assert.equal(response.toolExecutions.length, 0);
  assert.equal(response.pendingApprovals.length, 0);
  assert.equal(response.usage.totals.knownEvents, 2);
});

test("runAgentTurn auto-executes low-risk tools before responding", async () => {
  const conversationId = createConversationId("low-risk-tool");
  await harness.writeWorkspaceFile("docs/notes.txt", "Important note.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/notes.txt",
        },
        reason: "Read the note first.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        assert.equal(
          (context.lastToolResult?.output as { content: string }).content,
          "Important note.\n",
        );
        return createDecisionResult({
          type: "respond",
          reason: "I have enough context now.",
        });
      },
    ],
    responses: [
      (context) => {
        assert.equal(context.lastToolResult?.toolName, "fileTool");
        return createResponseResult("I read the note.");
      },
    ],
  });

  const response = await runAgentTurn({
    message: "Read the note and summarize it.",
    conversationId,
    provider,
  });

  assert.equal(response.status, "completed");
  assert.equal(response.toolExecutions.length, 1);
  assert.equal(response.toolExecutions[0]?.toolName, "fileTool");
  assert.equal(response.toolExecutions[0]?.status, "success");
  assert.equal(response.pendingApprovals.length, 0);
  assert.equal(response.messages[1]?.content, "I read the note.");
});

test("runAgentTurn recovers after an invalid tool call", async () => {
  const conversationId = createConversationId("invalid-tool-call");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
        },
        reason: "Attempt to read a file.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "error");
        assert.match(context.lastToolResult?.error ?? "", /Invalid fileTool call/);
        return createDecisionResult({
          type: "respond",
          reason: "Recover after the invalid tool call.",
        });
      },
    ],
    responses: [
      (context) => {
        assert.equal(context.lastToolResult?.status, "error");
        return createResponseResult("Recovered after validation failed.");
      },
    ],
  });

  const response = await runAgentTurn({
    message: "Try the broken tool call.",
    conversationId,
    provider,
  });

  assert.equal(response.status, "completed");
  assert.equal(response.toolExecutions.length, 0);
  assert.equal(response.messages[1]?.content, "Recovered after validation failed.");
});

test("runAgentTurn pauses for approval on medium-risk tool calls", async () => {
  const conversationId = createConversationId("approval-required");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/approved.txt",
          content: "Waiting for approval.\n",
        },
        reason: "Write the requested file.",
      }),
    ],
  });

  const response = await runAgentTurn({
    message: "Create the approved file.",
    conversationId,
    provider,
  });

  assert.equal(response.status, "approval_required");
  assert.ok(response.pendingApproval);
  assert.equal(response.pendingApproval?.toolName, "fileTool");
  assert.equal(response.pendingApprovals.length, 1);
  assert.equal(await harness.pathExists("drafts/approved.txt"), false);
});

test("handleApprovalDecision executes the approved tool and resumes the loop", async () => {
  const conversationId = createConversationId("approval-approve");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/final.txt",
          content: "Approved content.\n",
        },
        reason: "Write the requested file.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        return createDecisionResult({
          type: "respond",
          reason: "The file write has completed.",
        });
      },
    ],
    responses: [
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        return createResponseResult("The file has been written.");
      },
    ],
  });

  const pendingResponse = await runAgentTurn({
    message: "Create the final file.",
    conversationId,
    provider,
  });

  assert.equal(pendingResponse.status, "approval_required");
  assert.ok(pendingResponse.pendingApproval);

  const response = await handleApprovalDecision({
    requestId: pendingResponse.pendingApproval!.id,
    decision: "approve",
    provider,
  });

  assert.equal(response.status, "completed");
  assert.equal(response.toolExecution?.toolName, "fileTool");
  assert.equal(response.toolExecution?.status, "success");
  assert.equal(await harness.readWorkspaceFile("drafts/final.txt"), "Approved content.\n");
  assert.equal(response.pendingApprovals.length, 0);
  assert.equal(response.messages.at(-1)?.content, "The file has been written.");
});

test("handleApprovalDecision records a denial without mutating the workspace", async () => {
  const conversationId = createConversationId("approval-deny");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/denied.txt",
          content: "Denied content.\n",
        },
        reason: "Write the requested file.",
      }),
    ],
  });

  const pendingResponse = await runAgentTurn({
    message: "Create the denied file.",
    conversationId,
    provider,
  });

  assert.equal(pendingResponse.status, "approval_required");
  assert.ok(pendingResponse.pendingApproval);

  const response = await handleApprovalDecision({
    requestId: pendingResponse.pendingApproval!.id,
    decision: "deny",
    provider,
  });

  assert.equal(response.status, "denied");
  assert.equal(await harness.pathExists("drafts/denied.txt"), false);
  assert.equal(response.toolExecutions.length, 0);
  assert.equal(response.messages.at(-1)?.content, "Denied fileTool. No action was executed.");
});

test("streamAgentTurn emits the streaming response lifecycle in order", async () => {
  const conversationId = createConversationId("stream-turn");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "respond",
        reason: "No tool is needed.",
      }),
    ],
    streamResponses: [
      {
        content: "Hello world",
        deltas: ["Hello ", "world"],
        usage: createUsage("response", {
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
        }),
      },
    ],
  });
  const events: ChatStreamEvent[] = [];

  const response = await streamAgentTurn({
    message: "Say hello.",
    conversationId,
    provider,
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(response.status, "completed");
  assert.deepEqual(getEventTypes(events), [
    "phase.changed",
    "usage.updated",
    "phase.changed",
    "assistant.delta",
    "assistant.delta",
    "usage.updated",
    "assistant.completed",
    "usage.updated",
    "turn.completed",
  ]);
  assert.equal(events[0]?.type, "phase.changed");
  assert.equal(events[2]?.type, "phase.changed");
  assert.equal(events[6]?.type, "assistant.completed");
  assert.equal(events[8]?.type, "turn.completed");
});

test("streamApprovalDecision emits tool execution and streamed response events when approved", async () => {
  const conversationId = createConversationId("stream-approval-approve");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/stream-approved.txt",
          content: "Stream approval content.\n",
        },
        reason: "Write the requested file.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The file is ready.",
      }),
    ],
    streamResponses: [
      {
        content: "Applied",
        deltas: ["Ap", "plied"],
        usage: createUsage("response", {
          inputTokens: 9,
          outputTokens: 3,
          totalTokens: 12,
        }),
      },
    ],
  });
  const initialResponse = await runAgentTurn({
    message: "Create the streamed file.",
    conversationId,
    provider,
  });
  const events: ChatStreamEvent[] = [];

  assert.equal(initialResponse.status, "approval_required");
  assert.ok(initialResponse.pendingApproval);

  const response = await streamApprovalDecision({
    requestId: initialResponse.pendingApproval!.id,
    decision: "approve",
    provider,
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(response.status, "completed");
  assert.equal(await harness.readWorkspaceFile("drafts/stream-approved.txt"), "Stream approval content.\n");
  assert.deepEqual(getEventTypes(events), [
    "phase.changed",
    "tool.started",
    "tool.completed",
    "phase.changed",
    "usage.updated",
    "phase.changed",
    "assistant.delta",
    "assistant.delta",
    "usage.updated",
    "assistant.completed",
    "usage.updated",
    "turn.completed",
  ]);
});

test("streamApprovalDecision emits the denial lifecycle without executing the tool", async () => {
  const conversationId = createConversationId("stream-approval-deny");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/stream-denied.txt",
          content: "Should not be written.\n",
        },
        reason: "Write the requested file.",
      }),
    ],
  });
  const initialResponse = await runAgentTurn({
    message: "Create the streamed denied file.",
    conversationId,
    provider,
  });
  const events: ChatStreamEvent[] = [];

  assert.equal(initialResponse.status, "approval_required");
  assert.ok(initialResponse.pendingApproval);

  const response = await streamApprovalDecision({
    requestId: initialResponse.pendingApproval!.id,
    decision: "deny",
    provider,
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(response.status, "denied");
  assert.equal(await harness.pathExists("drafts/stream-denied.txt"), false);
  assert.deepEqual(getEventTypes(events), [
    "assistant.completed",
    "usage.updated",
    "turn.completed",
  ]);
});
