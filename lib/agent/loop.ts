import type {
  ApprovalRequestRecord,
  ApproveRouteResponse,
  ChatPhase,
  ChatRouteResponse,
  ChatStreamEvent,
  HistoryPayload,
  ProviderContext,
  ToolExecutionRecord,
  ToolResult,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import {
  createApprovalRequest,
  finishToolExecution,
  getApprovalRequest,
  getConversationUsageSummary,
  getHistoryPayload,
  getLatestUserMessage,
  getMessageById,
  insertMessage,
  loadConversationMemory,
  logLlmUsageEvent,
  logToolExecutionStart,
  maybeSummarizeConversation,
  resolveApprovalRequest,
} from "@/lib/agent/memory";
import { planNextStep } from "@/lib/agent/planner";
import { evaluateToolSafety } from "@/lib/agent/safety";
import type { AgentProvider } from "@/lib/llm/provider";
import { getDefaultProvider } from "@/lib/llm/resolveProvider";
import {
  toApprovalSummaryRecord,
  toToolTimelineRecord,
} from "@/lib/agent/presentation";
import type { ToolPresentationDetails } from "@/lib/agent/types";
import { validateToolCall } from "@/lib/tools/registry";
import { prepareCodeToolOperation } from "@/lib/tools/codeTool";
import { toErrorMessage } from "@/lib/utils";

const LOOP_LIMIT = 8;

type TurnEventSink = (event: ChatStreamEvent) => Promise<void> | void;

function toHistoryPayload(response: ChatRouteResponse | ApproveRouteResponse): HistoryPayload {
  return {
    messages: response.messages,
    toolExecutions: response.toolExecutions,
    pendingApprovals: response.pendingApprovals,
    usage: response.usage,
  };
}

async function emitEvent(onEvent: TurnEventSink | undefined, event: ChatStreamEvent) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}

async function emitPhase(
  onEvent: TurnEventSink | undefined,
  phase: ChatPhase,
  label: string,
) {
  await emitEvent(onEvent, {
    type: "phase.changed",
    phase,
    label,
  });
}

async function emitUsageUpdate(
  conversationId: string,
  onEvent: TurnEventSink | undefined,
) {
  const usage = await getConversationUsageSummary(conversationId);

  await emitEvent(onEvent, {
    type: "usage.updated",
    usage,
  });
}

async function recordAssistantError({
  conversationId,
  provider,
  sourceMessageId,
  content,
}: {
  conversationId: string;
  provider: AgentProvider;
  sourceMessageId: string | null;
  content: string;
}) {
  await insertMessage({
    conversationId,
    role: "assistant",
    kind: "error",
    content,
  });

  await maybeSummarizeConversation(provider, conversationId, sourceMessageId);
}

async function buildChatResponse(
  conversationId: string,
  status: ChatRouteResponse["status"],
  pendingApproval?: ApprovalRequestRecord,
): Promise<ChatRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    pendingApproval: pendingApproval ? toApprovalSummaryRecord(pendingApproval) : undefined,
  };
}

async function buildApproveResponse(
  conversationId: string,
  status: ApproveRouteResponse["status"],
  toolExecution?: ToolExecutionRecord,
): Promise<ApproveRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    toolExecution: toolExecution ? toToolTimelineRecord(toolExecution) : undefined,
  };
}

async function executeTool({
  conversationId,
  toolName,
  args,
  presentation,
  riskLevel,
  onEvent,
}: {
  conversationId: string;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolResult["riskLevel"];
  onEvent?: TurnEventSink;
}) {
  await emitPhase(onEvent, "running_tool", `Running ${toolName}`);

  const execution = await logToolExecutionStart({
    conversationId,
    toolName,
    args,
    presentation,
    riskLevel,
  });

  await emitEvent(onEvent, {
    type: "tool.started",
    toolExecution: toToolTimelineRecord(execution),
  });

  const { tool, parsedArgs } = validateToolCall(toolName, args);

  let toolResult: ToolResult;
  try {
    const output = await tool.execute(parsedArgs);
    toolResult = {
      toolName,
      args,
      riskLevel,
      status: "success",
      output,
      error: null,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    toolResult = {
      toolName,
      args,
      riskLevel,
      status: message.startsWith("Blocked:") ? "blocked" : "error",
      output: null,
      error: message,
    };
  }

  const storedExecution = await finishToolExecution(execution.id, toolResult, presentation);

  if (storedExecution) {
    await emitEvent(onEvent, {
      type: "tool.completed",
      toolExecution: toToolTimelineRecord(storedExecution),
    });
  }

  return {
    storedExecution,
    toolResult,
  };
}

async function completeTurn<T extends ChatRouteResponse | ApproveRouteResponse>(
  response: T,
  onEvent?: TurnEventSink,
): Promise<T> {
  await emitEvent(onEvent, {
    type: "turn.completed",
    status: response.status,
    history: toHistoryPayload(response),
  });

  return response;
}

async function failTurn(
  conversationId: string,
  provider: AgentProvider,
  sourceMessageId: string | null,
  content: string,
  onEvent?: TurnEventSink,
) {
  await recordAssistantError({
    conversationId,
    provider,
    sourceMessageId,
    content,
  });
  await emitUsageUpdate(conversationId, onEvent);

  const response = await buildChatResponse(conversationId, "error");

  await emitEvent(onEvent, {
    type: "turn.error",
    error: content,
    history: toHistoryPayload(response),
  });

  return response;
}

async function respondToUser({
  context,
  provider,
  sourceMessageId,
  onEvent,
}: {
  context: ProviderContext;
  provider: AgentProvider;
  sourceMessageId: string | null;
  onEvent?: TurnEventSink;
}) {
  await emitPhase(onEvent, "responding", "Responding");

  const response = onEvent && provider.streamResponse
    ? await provider.streamResponse(context, async (delta) => {
        if (!delta) {
          return;
        }

        await emitEvent(onEvent, {
          type: "assistant.delta",
          delta,
        });
      })
    : await provider.respond(context);

  await logLlmUsageEvent({
    conversationId: context.conversationId,
    sourceMessageId,
    usage: response.usage,
  });
  await emitUsageUpdate(context.conversationId, onEvent);

  const assistantMessage = await insertMessage({
    conversationId: context.conversationId,
    role: "assistant",
    kind: "text",
    content: response.content,
  });

  await emitEvent(onEvent, {
    type: "assistant.completed",
    message: assistantMessage,
  });

  await maybeSummarizeConversation(provider, context.conversationId, sourceMessageId);
  await emitUsageUpdate(context.conversationId, onEvent);

  return buildChatResponse(context.conversationId, "completed");
}

async function continueAgentLoop({
  conversationId,
  provider,
  latestUserMessageId,
  latestUserMessage,
  initialToolResult,
  onEvent,
}: {
  conversationId: string;
  provider: AgentProvider;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
  onEvent?: TurnEventSink;
}) {
  let lastToolResult = initialToolResult;

  for (let index = 0; index < LOOP_LIMIT; index += 1) {
    const memory = await loadConversationMemory(conversationId);
    const providerContext: ProviderContext = {
      conversationId,
      summary: memory.summary,
      recentMessages: memory.recentMessages,
      recentToolExecutions: memory.recentToolExecutions,
      latestUserMessage,
      lastToolResult,
      stepIndex: index + 1,
    };

    await emitPhase(onEvent, "planning", "Planning");

    let decisionResult;

    try {
      decisionResult = await planNextStep(provider, providerContext);
      await logLlmUsageEvent({
        conversationId,
        sourceMessageId: latestUserMessageId,
        usage: decisionResult.usage,
      });
      await emitUsageUpdate(conversationId, onEvent);
    } catch (error) {
      return failTurn(
        conversationId,
        provider,
        latestUserMessageId,
        `I couldn't plan the next step because ${toErrorMessage(error)}`,
        onEvent,
      );
    }

    const decision = decisionResult.decision;

    if (decision.type === "respond") {
      const response = await respondToUser({
        context: providerContext,
        provider,
        sourceMessageId: latestUserMessageId,
        onEvent,
      });

      return completeTurn(response, onEvent);
    }

    let parsedArgs;
    let riskLevel: ToolResult["riskLevel"];
    let presentation: ToolPresentationDetails | null = null;

    try {
      const validatedToolCall = validateToolCall(decision.toolName, decision.args);
      parsedArgs = validatedToolCall.parsedArgs;
      riskLevel = validatedToolCall.tool.getRiskLevel(parsedArgs);

      if (decision.toolName === "codeTool") {
        presentation = (await prepareCodeToolOperation(parsedArgs)).presentation;
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: decision.args,
        riskLevel: "low",
        status: "error",
        output: null,
        error: `Invalid ${decision.toolName} call: ${toErrorMessage(error)}`,
      };
      continue;
    }

    try {
      const safety = await evaluateToolSafety(decision.toolName, parsedArgs, riskLevel);

      if (safety.requiresApproval) {
        await emitPhase(onEvent, "waiting_approval", `Waiting for approval for ${decision.toolName}`);

        const pendingApproval = await createApprovalRequest({
          conversationId,
          sourceMessageId: latestUserMessageId,
          toolName: decision.toolName,
          args: parsedArgs,
          presentation,
          riskLevel,
          reason: decision.reason,
        });

        await emitEvent(onEvent, {
          type: "approval.required",
          approval: toApprovalSummaryRecord(pendingApproval),
        });

        await maybeSummarizeConversation(provider, conversationId, latestUserMessageId);
        await emitUsageUpdate(conversationId, onEvent);

        const response = await buildChatResponse(conversationId, "approval_required", pendingApproval);

        return completeTurn(response, onEvent);
      }
    } catch (error) {
      lastToolResult = {
        toolName: decision.toolName,
        args: parsedArgs,
        riskLevel,
        status: "error",
        output: null,
        error: `Safety evaluation failed for ${decision.toolName}: ${toErrorMessage(error)}`,
      };
      continue;
    }

    const executionResult = await executeTool({
      conversationId,
      toolName: decision.toolName,
      args: parsedArgs,
      presentation,
      riskLevel,
      onEvent,
    });

    lastToolResult = executionResult.toolResult;
  }

  return failTurn(
    conversationId,
    provider,
    latestUserMessageId,
    "I hit the step limit before I could finish. Ask me to continue or narrow the task.",
    onEvent,
  );
}

export async function runAgentTurn({
  message,
  conversationId = DEFAULT_CONVERSATION_ID,
  provider = getDefaultProvider(),
}: {
  message: string;
  conversationId?: string;
  provider?: AgentProvider;
}): Promise<ChatRouteResponse> {
  const userMessage = await insertMessage({
    conversationId,
    role: "user",
    content: message,
  });

  return continueAgentLoop({
    conversationId,
    provider,
    latestUserMessageId: userMessage.id,
    latestUserMessage: userMessage.content,
  });
}

export async function streamAgentTurn({
  message,
  conversationId = DEFAULT_CONVERSATION_ID,
  provider = getDefaultProvider(),
  onEvent,
}: {
  message: string;
  conversationId?: string;
  provider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const userMessage = await insertMessage({
    conversationId,
    role: "user",
    content: message,
  });

  return continueAgentLoop({
    conversationId,
    provider,
    latestUserMessageId: userMessage.id,
    latestUserMessage: userMessage.content,
    onEvent,
  });
}

export async function handleApprovalDecision({
  requestId,
  decision,
  provider = getDefaultProvider(),
}: {
  requestId: string;
  decision: "approve" | "deny";
  provider?: AgentProvider;
}): Promise<ApproveRouteResponse> {
  const approvalRequest = await getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error("Approval request not found.");
  }

  if (approvalRequest.status !== "pending") {
    throw new Error("Approval request has already been resolved.");
  }

  const updatedApproval = await resolveApprovalRequest(requestId, decision === "approve" ? "approved" : "denied");
  if (!updatedApproval) {
    throw new Error("Failed to update approval request.");
  }

  if (decision === "deny") {
    await insertMessage({
      conversationId: updatedApproval.conversationId,
      role: "assistant",
      kind: "text",
      content: `Denied ${updatedApproval.toolName}. No action was executed.`,
      meta: {
        approvalRequestId: updatedApproval.id,
      },
    });
    await maybeSummarizeConversation(provider, updatedApproval.conversationId, updatedApproval.sourceMessageId);
    return buildApproveResponse(updatedApproval.conversationId, "denied");
  }

  const sourceMessage = updatedApproval.sourceMessageId
    ? await getMessageById(updatedApproval.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(updatedApproval.conversationId);
  const executionResult = await executeTool({
    conversationId: updatedApproval.conversationId,
    toolName: updatedApproval.toolName,
    args: updatedApproval.args,
    presentation: updatedApproval.presentation,
    riskLevel: updatedApproval.riskLevel,
  });

  const continuedResponse = await continueAgentLoop({
    conversationId: updatedApproval.conversationId,
    provider,
    latestUserMessageId: sourceMessage?.id ?? updatedApproval.sourceMessageId,
    latestUserMessage,
    initialToolResult: executionResult.toolResult,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}

export async function streamApprovalDecision({
  requestId,
  decision,
  provider = getDefaultProvider(),
  onEvent,
}: {
  requestId: string;
  decision: "approve" | "deny";
  provider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const approvalRequest = await getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error("Approval request not found.");
  }

  if (approvalRequest.status !== "pending") {
    throw new Error("Approval request has already been resolved.");
  }

  const updatedApproval = await resolveApprovalRequest(requestId, decision === "approve" ? "approved" : "denied");
  if (!updatedApproval) {
    throw new Error("Failed to update approval request.");
  }

  if (decision === "deny") {
    const denialMessage = await insertMessage({
      conversationId: updatedApproval.conversationId,
      role: "assistant",
      kind: "text",
      content: `Denied ${updatedApproval.toolName}. No action was executed.`,
      meta: {
        approvalRequestId: updatedApproval.id,
      },
    });

    await emitEvent(onEvent, {
      type: "assistant.completed",
      message: denialMessage,
    });

    await maybeSummarizeConversation(provider, updatedApproval.conversationId, updatedApproval.sourceMessageId);
    await emitUsageUpdate(updatedApproval.conversationId, onEvent);

    const response = await buildApproveResponse(updatedApproval.conversationId, "denied");

    return completeTurn(response, onEvent);
  }

  const sourceMessage = updatedApproval.sourceMessageId
    ? await getMessageById(updatedApproval.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(updatedApproval.conversationId);
  const executionResult = await executeTool({
    conversationId: updatedApproval.conversationId,
    toolName: updatedApproval.toolName,
    args: updatedApproval.args,
    presentation: updatedApproval.presentation,
    riskLevel: updatedApproval.riskLevel,
    onEvent,
  });

  return continueAgentLoop({
    conversationId: updatedApproval.conversationId,
    provider,
    latestUserMessageId: sourceMessage?.id ?? updatedApproval.sourceMessageId,
    latestUserMessage,
    initialToolResult: executionResult.toolResult,
    onEvent,
  });
}
