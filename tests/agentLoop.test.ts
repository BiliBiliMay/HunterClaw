import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { ChatStreamEvent } from "@/lib/agent/types";
import {
  handleApprovalDecision,
  retryToolExecution,
  runAgentTurn,
  streamAgentTurn,
  streamApprovalDecision,
  streamRetryToolExecution,
} from "@/lib/agent/loop";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { fileTool } from "@/lib/tools/fileTool";

import {
  createConversationId,
  createDecisionResult,
  createFakeProvider,
  createResponseResult,
  createSubAgentSummaryResult,
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

async function withMockedFileToolExecute(
  execute: typeof fileTool.execute,
  run: () => Promise<void>,
) {
  const originalExecute = fileTool.execute;
  fileTool.execute = execute;

  try {
    await run();
  } finally {
    fileTool.execute = originalExecute;
  }
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

test("runAgentTurn auto-retries transient tool failures once before responding", async () => {
  const conversationId = createConversationId("auto-retry-success");
  await harness.writeWorkspaceFile("docs/retry.txt", "Recovered note.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/retry.txt",
        },
        reason: "Read the retryable note first.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        return createDecisionResult({
          type: "respond",
          reason: "The retry succeeded.",
        });
      },
    ],
    responses: [
      () => createResponseResult("Recovered after an automatic retry."),
    ],
  });
  const originalExecute = fileTool.execute.bind(fileTool);
  let attempts = 0;

  await withMockedFileToolExecute(async (args) => {
    attempts += 1;

    if (attempts === 1) {
      throw new Error("Operation timed out while reading the file.");
    }

    return originalExecute(args);
  }, async () => {
    const response = await runAgentTurn({
      message: "Read the retryable note.",
      conversationId,
      provider,
    });

    assert.equal(response.status, "completed");
    assert.equal(response.toolExecutions.length, 2);
    assert.equal(response.toolExecutions[0]?.status, "error");
    assert.equal(response.toolExecutions[0]?.retryable, true);
    assert.match(response.toolExecutions[0]?.error ?? "", /timed out/i);
    assert.equal(response.toolExecutions[1]?.status, "success");
    assert.equal(response.toolExecutions[1]?.retryOfExecutionId, response.toolExecutions[0]?.id ?? null);
    assert.equal(response.messages.at(-1)?.content, "Recovered after an automatic retry.");
  });

  assert.equal(attempts, 2);
});

test("runAgentTurn does not auto-retry non-retryable tool failures", async () => {
  const conversationId = createConversationId("non-retryable-failure");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/missing.txt",
        },
        reason: "Try to read the missing file.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "error");
        assert.equal(context.lastToolResult?.retryable, false);
        return createDecisionResult({
          type: "respond",
          reason: "Explain the missing file.",
        });
      },
    ],
    responses: [
      () => createResponseResult("The file does not exist."),
    ],
  });

  const response = await runAgentTurn({
    message: "Try to read the missing file.",
    conversationId,
    provider,
  });

  assert.equal(response.status, "completed");
  assert.equal(response.toolExecutions.length, 1);
  assert.equal(response.toolExecutions[0]?.status, "error");
  assert.equal(response.toolExecutions[0]?.retryable, false);
  assert.match(response.toolExecutions[0]?.error ?? "", /ENOENT/);
});

test("runAgentTurn stops with retry_required when the model repeats the same failed tool call", async () => {
  const conversationId = createConversationId("retry-required");
  await harness.writeWorkspaceFile("docs/retry-boundary.txt", "Retry boundary.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/retry-boundary.txt",
        },
        reason: "Attempt the read.",
      }),
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/retry-boundary.txt",
        },
        reason: "Try the same read again.",
      }),
    ],
  });

  await withMockedFileToolExecute(async () => {
    throw new Error("Operation timed out while reading the file.");
  }, async () => {
    const response = await runAgentTurn({
      message: "Read the file even if it flakes.",
      conversationId,
      provider,
    });

    assert.equal(response.status, "retry_required");
    assert.equal(response.toolExecutions.length, 2);
    assert.equal(response.toolExecutions[0]?.retryable, true);
    assert.equal(response.toolExecutions[1]?.retryable, true);
    assert.match(response.messages.at(-1)?.content ?? "", /fileTool failed/i);
    assert.match(response.messages.at(-1)?.content ?? "", /Retry the failed tool execution/i);
  });
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

test("retryToolExecution reruns the failed tool call and continues the loop", async () => {
  const conversationId = createConversationId("manual-retry");
  await harness.writeWorkspaceFile("docs/manual-retry.txt", "Manual retry content.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/manual-retry.txt",
        },
        reason: "Attempt the flaky read.",
      }),
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/manual-retry.txt",
        },
        reason: "Try the same flaky read again.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        return createDecisionResult({
          type: "respond",
          reason: "The manual retry succeeded.",
        });
      },
    ],
    responses: [
      () => createResponseResult("Manual retry completed."),
    ],
  });
  const originalExecute = fileTool.execute.bind(fileTool);
  let attempts = 0;

  await withMockedFileToolExecute(async (args) => {
    attempts += 1;

    if (attempts < 3) {
      throw new Error("Operation timed out while reading the file.");
    }

    return originalExecute(args);
  }, async () => {
    const initialResponse = await runAgentTurn({
      message: "Read the flaky file.",
      conversationId,
      provider,
    });

    assert.equal(initialResponse.status, "retry_required");
    const failedExecution = initialResponse.toolExecutions.at(-1);

    assert.ok(failedExecution);

    const response = await retryToolExecution({
      toolExecutionId: failedExecution.id,
      provider,
    });

    assert.equal(response.status, "completed");
    assert.equal(response.toolExecution?.status, "success");
    assert.equal(response.toolExecution?.retryOfExecutionId, failedExecution.id);
    assert.equal(response.pendingApprovals.length, 0);
    assert.equal(response.messages.at(-1)?.content, "Manual retry completed.");
  });

  assert.equal(attempts, 3);
});

test("retryToolExecution bypasses approval when retrying a previously approved failed tool", async () => {
  const conversationId = createConversationId("approval-retry");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/retry-after-approval.txt",
          content: "Retried after approval.\n",
        },
        reason: "Write the requested file.",
      }),
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/retry-after-approval.txt",
          content: "Retried after approval.\n",
        },
        reason: "Try the same write again.",
      }),
      (context) => {
        assert.equal(context.lastToolResult?.status, "success");
        return createDecisionResult({
          type: "respond",
          reason: "The manual retry write succeeded.",
        });
      },
    ],
    responses: [
      () => createResponseResult("Retried write completed."),
    ],
  });
  const originalExecute = fileTool.execute.bind(fileTool);
  let attempts = 0;

  await withMockedFileToolExecute(async (args) => {
    attempts += 1;

    if (attempts < 3) {
      throw new Error("Operation timed out while writing the file.");
    }

    return originalExecute(args);
  }, async () => {
    const pendingResponse = await runAgentTurn({
      message: "Create the retry-after-approval file.",
      conversationId,
      provider,
    });

    assert.equal(pendingResponse.status, "approval_required");
    assert.ok(pendingResponse.pendingApproval);

    const approvalResponse = await handleApprovalDecision({
      requestId: pendingResponse.pendingApproval!.id,
      decision: "approve",
      provider,
    });

    assert.equal(approvalResponse.status, "retry_required");
    assert.equal(approvalResponse.pendingApprovals.length, 0);

    const failedExecution = approvalResponse.toolExecutions.at(-1);
    assert.ok(failedExecution);

    const retryResponse = await retryToolExecution({
      toolExecutionId: failedExecution.id,
      provider,
    });

    assert.equal(retryResponse.status, "completed");
    assert.equal(retryResponse.pendingApprovals.length, 0);
    assert.equal(await harness.readWorkspaceFile("drafts/retry-after-approval.txt"), "Retried after approval.\n");
  });

  assert.equal(attempts, 3);
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

test("streamRetryToolExecution emits tool execution and streamed response events", async () => {
  const conversationId = createConversationId("stream-retry");
  await harness.writeWorkspaceFile("docs/stream-retry.txt", "Streaming retry.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/stream-retry.txt",
        },
        reason: "Attempt the flaky read.",
      }),
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/stream-retry.txt",
        },
        reason: "Repeat the flaky read.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The retry succeeded.",
      }),
    ],
    streamResponses: [
      {
        content: "Recovered",
        deltas: ["Reco", "vered"],
        usage: createUsage("response", {
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
        }),
      },
    ],
  });
  const originalExecute = fileTool.execute.bind(fileTool);
  let attempts = 0;

  await withMockedFileToolExecute(async (args) => {
    attempts += 1;

    if (attempts < 3) {
      throw new Error("Operation timed out while reading the file.");
    }

    return originalExecute(args);
  }, async () => {
    const initialResponse = await runAgentTurn({
      message: "Read the flaky stream file.",
      conversationId,
      provider,
    });
    const failedExecution = initialResponse.toolExecutions.at(-1);
    const events: ChatStreamEvent[] = [];

    assert.equal(initialResponse.status, "retry_required");
    assert.ok(failedExecution);

    const response = await streamRetryToolExecution({
      toolExecutionId: failedExecution.id,
      provider,
      onEvent(event) {
        events.push(event);
      },
    });

    assert.equal(response.status, "completed");
    assert.equal(response.toolExecution?.status, "success");
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

  assert.equal(attempts, 3);
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

test("simple turns stay on the planner direct path and do not create executor runs", async () => {
  const conversationId = createConversationId("planner-direct-only");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "respond",
        reason: "No delegation is required.",
      }),
    ],
    responses: [
      () => createResponseResult("Handled directly by the planner."),
    ],
  });

  const response = await runAgentTurn({
    message: "Answer this directly.",
    conversationId,
    provider,
  });

  const runRows = db
    .select()
    .from(agentRuns)
    .all()
    .filter((row) => row.conversationId === conversationId);

  assert.equal(response.status, "completed");
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0]?.role, "planner");
});

test("complex turns delegate to the executor and planner context only receives compact executor results", async () => {
  const conversationId = createConversationId("planner-delegates");
  await harness.writeWorkspaceFile("docs/delegated.txt", "Delegated note.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Read docs/delegated.txt and confirm its contents.",
        successCriteria: "The note has been inspected.",
        notes: "Return only the important result.",
        reason: "This needs repo inspection before answering.",
      }),
      (context) => {
        assert.equal(context.role, "planner");
        assert.equal(context.recentExecutorResults.length, 1);
        assert.match(context.recentExecutorResults[0]?.summary ?? "", /delegated\.txt/);
        assert.equal(
          context.recentToolExecutions.some((toolExecution) => toolExecution.agentRole === "executor"),
          false,
        );
        return createDecisionResult({
          type: "respond",
          reason: "The executor has finished.",
        });
      },
    ],
    responses: [
      (context) => {
        assert.equal(context.role, "planner");
        assert.equal(context.recentExecutorResults.length, 1);
        assert.deepEqual(context.recentExecutorResults[0]?.keyArtifacts ?? [], ["docs/delegated.txt"]);
        return createResponseResult("The delegated note was read.");
      },
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/delegated.txt",
        },
        reason: "Inspect the delegated note.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "Ready to hand the result back.",
      }),
    ],
    subAgentSummaries: [
      (context) => {
        assert.equal(context.role, "executor");
        assert.equal(context.delegatedTask, "Read docs/delegated.txt and confirm its contents.");
        return createSubAgentSummaryResult({
          summary: "Read docs/delegated.txt and confirmed the delegated note.",
          keyArtifacts: ["docs/delegated.txt"],
          lastToolResult: context.lastToolResult ?? null,
        });
      },
    ],
  });

  const response = await runAgentTurn({
    message: "Read the delegated file and report back.",
    conversationId,
    provider,
    executorProvider,
  });

  const runRows = db
    .select()
    .from(agentRuns)
    .all()
    .filter((row) => row.conversationId === conversationId);

  assert.equal(response.status, "completed");
  assert.equal(response.toolExecutions.length, 1);
  assert.equal(response.toolExecutions[0]?.agentRole, "executor");
  assert.equal(response.messages.at(-1)?.content, "The delegated note was read.");
  assert.deepEqual(runRows.map((row) => row.role), ["planner", "executor"]);
});

test("planner can launch multiple executor runs sequentially in one turn", async () => {
  const conversationId = createConversationId("multiple-executors");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Inspect phase one.",
        successCriteria: "Phase one is complete.",
        reason: "First multi-step phase.",
      }),
      (context) => {
        assert.equal(context.role, "planner");
        assert.equal(context.recentExecutorResults.length, 1);
        return createDecisionResult({
          type: "delegate",
          task: "Inspect phase two.",
          successCriteria: "Phase two is complete.",
          reason: "Second multi-step phase.",
        });
      },
      (context) => {
        assert.equal(context.role, "planner");
        assert.equal(context.recentExecutorResults.length, 2);
        return createDecisionResult({
          type: "respond",
          reason: "Both executor phases are done.",
        });
      },
    ],
    responses: [
      () => createResponseResult("Both delegated phases completed."),
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "respond",
        reason: "Phase one complete.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "Phase two complete.",
      }),
    ],
    subAgentSummaries: [
      (context) => {
        assert.equal(context.role, "executor");
        return createSubAgentSummaryResult({
          summary: `Completed ${context.delegatedTask}`,
          keyArtifacts: [context.delegatedTask],
          lastToolResult: context.lastToolResult ?? null,
        });
      },
      (context) => {
        assert.equal(context.role, "executor");
        return createSubAgentSummaryResult({
          summary: `Completed ${context.delegatedTask}`,
          keyArtifacts: [context.delegatedTask],
          lastToolResult: context.lastToolResult ?? null,
        });
      },
    ],
  });

  const response = await runAgentTurn({
    message: "Run both delegated phases.",
    conversationId,
    provider,
    executorProvider,
  });

  const runRows = db
    .select()
    .from(agentRuns)
    .all()
    .filter((row) => row.conversationId === conversationId);

  assert.equal(response.status, "completed");
  assert.equal(runRows.filter((row) => row.role === "executor").length, 2);
  assert.equal(response.messages.at(-1)?.content, "Both delegated phases completed.");
});

test("executor runs cannot recurse into nested delegation", async () => {
  const conversationId = createConversationId("executor-no-recursion");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Attempt a nested delegation.",
        successCriteria: "Executor handles the task without creating a child executor.",
        reason: "This is a delegated task.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "Executor corrected itself.",
      }),
    ],
    responses: [
      () => createResponseResult("Nested delegation was refused."),
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "This should not be allowed.",
        successCriteria: "Should never happen.",
        reason: "Bad nested delegation.",
      }),
      (context) => {
        assert.equal(context.role, "executor");
        assert.match(context.lastToolResult?.error ?? "", /cannot delegate/i);
        return createDecisionResult({
          type: "respond",
          reason: "Return control after the invalid nested delegation.",
        });
      },
    ],
    subAgentSummaries: [
      (context) =>
        createSubAgentSummaryResult({
          summary: "Executor stayed single-level and reported the invalid nested delegation.",
          keyArtifacts: [],
          lastToolResult: context.lastToolResult ?? null,
        }),
    ],
  });

  const response = await runAgentTurn({
    message: "Try the nested executor flow.",
    conversationId,
    provider,
    executorProvider,
  });

  const runRows = db
    .select()
    .from(agentRuns)
    .all()
    .filter((row) => row.conversationId === conversationId);

  assert.equal(response.status, "completed");
  assert.equal(runRows.length, 2);
  assert.equal(runRows.filter((row) => row.role === "executor").length, 1);
});

test("approvals created inside executor runs resume the executor and then return to planner", async () => {
  const conversationId = createConversationId("executor-approval");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Create drafts/executor-approved.txt through the executor.",
        successCriteria: "The file exists with the approved content.",
        reason: "This requires delegated file mutation.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The delegated approval flow completed.",
      }),
    ],
    responses: [
      () => createResponseResult("The executor-created file was approved and written."),
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "writeFile",
          path: "drafts/executor-approved.txt",
          content: "Executor approval path.\n",
        },
        reason: "Create the delegated file.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The file has been written.",
      }),
    ],
    subAgentSummaries: [
      (context) =>
        createSubAgentSummaryResult({
          summary: "Created drafts/executor-approved.txt after approval.",
          keyArtifacts: ["drafts/executor-approved.txt"],
          lastToolResult: context.lastToolResult ?? null,
        }),
    ],
  });

  const initialResponse = await runAgentTurn({
    message: "Create the delegated approved file.",
    conversationId,
    provider,
    executorProvider,
  });

  assert.equal(initialResponse.status, "approval_required");
  assert.ok(initialResponse.pendingApproval);

  const response = await handleApprovalDecision({
    requestId: initialResponse.pendingApproval!.id,
    decision: "approve",
    provider,
    executorProvider,
  });

  assert.equal(response.status, "completed");
  assert.equal(await harness.readWorkspaceFile("drafts/executor-approved.txt"), "Executor approval path.\n");
  assert.equal(response.toolExecution?.agentRole, "executor");
  assert.equal(response.messages.at(-1)?.content, "The executor-created file was approved and written.");
});

test("retry created inside executor runs resumes the executor first and then returns to planner", async () => {
  const conversationId = createConversationId("executor-retry");
  await harness.writeWorkspaceFile("docs/executor-retry.txt", "Retry executor note.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Read docs/executor-retry.txt through the executor.",
        successCriteria: "The delegated read succeeds.",
        reason: "This is a delegated retry case.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The retry finished.",
      }),
    ],
    responses: [
      () => createResponseResult("The executor retry completed successfully."),
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/executor-retry.txt",
        },
        reason: "Attempt the delegated read.",
      }),
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/executor-retry.txt",
        },
        reason: "Repeat the failed delegated read.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The delegated retry worked.",
      }),
    ],
    subAgentSummaries: [
      (context) =>
        createSubAgentSummaryResult({
          summary: "Read docs/executor-retry.txt after a manual retry.",
          keyArtifacts: ["docs/executor-retry.txt"],
          lastToolResult: context.lastToolResult ?? null,
        }),
    ],
  });
  let attempts = 0;
  const originalExecute = fileTool.execute.bind(fileTool);

  await withMockedFileToolExecute(async (args) => {
    attempts += 1;

    if (attempts <= 2) {
      throw new Error("Operation timed out while reading the file.");
    }

    return originalExecute(args);
  }, async () => {
    const initialResponse = await runAgentTurn({
      message: "Read the delegated retry file.",
      conversationId,
      provider,
      executorProvider,
    });

    assert.equal(initialResponse.status, "retry_required");
    assert.equal(initialResponse.toolExecutions.length, 2);
    assert.equal(initialResponse.toolExecutions[0]?.agentRole, "executor");

    const retryResponse = await retryToolExecution({
      toolExecutionId: initialResponse.toolExecutions[1]!.id,
      provider,
      executorProvider,
    });

    assert.equal(retryResponse.status, "completed");
    assert.equal(retryResponse.toolExecution?.agentRole, "executor");
    assert.equal(retryResponse.messages.at(-1)?.content, "The executor retry completed successfully.");
  });
});

test("streamAgentTurn keeps SSE events valid when the planner delegates to the executor", async () => {
  const conversationId = createConversationId("stream-delegation");
  await harness.writeWorkspaceFile("docs/stream-delegation.txt", "Stream delegated note.\n");
  const provider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "delegate",
        task: "Read docs/stream-delegation.txt through the executor.",
        successCriteria: "The delegated note is read.",
        reason: "Need delegated repo inspection.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "The delegated read is complete.",
      }),
    ],
    streamResponses: [
      {
        content: "Delegated streaming complete.",
        deltas: ["Delegated ", "streaming ", "complete."],
        usage: createUsage("response"),
      },
    ],
  });
  const executorProvider = createFakeProvider({
    planDecisions: [
      createDecisionResult({
        type: "tool_call",
        toolName: "fileTool",
        args: {
          action: "readFile",
          path: "docs/stream-delegation.txt",
        },
        reason: "Inspect the delegated stream file.",
      }),
      createDecisionResult({
        type: "respond",
        reason: "Return to the planner.",
      }),
    ],
    subAgentSummaries: [
      (context) =>
        createSubAgentSummaryResult({
          summary: "Read docs/stream-delegation.txt and returned to the planner.",
          keyArtifacts: ["docs/stream-delegation.txt"],
          lastToolResult: context.lastToolResult ?? null,
        }),
    ],
  });
  const events: ChatStreamEvent[] = [];

  const response = await streamAgentTurn({
    message: "Stream the delegated read.",
    conversationId,
    provider,
    executorProvider,
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(response.status, "completed");
  assert.ok(getEventTypes(events).includes("tool.started"));
  assert.ok(getEventTypes(events).includes("tool.completed"));
  assert.ok(getEventTypes(events).includes("assistant.delta"));
  assert.equal(response.toolExecutions[0]?.agentRole, "executor");
});
