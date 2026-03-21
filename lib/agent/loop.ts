import type {
  ApprovalRequestRecord,
  ApproveRouteResponse,
  ChatPhase,
  ChatRouteResponse,
  ChatStreamEvent,
  HistoryPayload,
  ProviderContext,
  RetryRouteResponse,
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
  getToolExecutionById,
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
import { toErrorMessage, toStableJsonString } from "@/lib/utils";

const LOOP_LIMIT = 8;
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
const TRANSIENT_ERROR_PATTERNS = [
  /timed out/i,
  /temporary/i,
  /network error/i,
  /net::ERR_/i,
];
const TRANSIENT_BROWSER_ERROR_PATTERNS = [
  /Target page, context or browser has been closed/i,
  /browser has been closed/i,
  /page has been closed/i,
  /context has been closed/i,
  /Execution context was destroyed/i,
];

type TurnEventSink = (event: ChatStreamEvent) => Promise<void> | void;

function toHistoryPayload(
  response: ChatRouteResponse | ApproveRouteResponse | RetryRouteResponse,
): HistoryPayload {
  return {
    messages: response.messages,
    toolExecutions: response.toolExecutions,
    pendingApprovals: response.pendingApprovals,
    usage: response.usage,
  };
}

function getErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }

  return null;
}

function isRetryableToolFailure(toolName: string, message: string, error: unknown) {
  if (message.startsWith("Blocked:")) {
    return false;
  }

  const code = getErrorCode(error);
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  if (toolName === "browserTool") {
    return [...TRANSIENT_ERROR_PATTERNS, ...TRANSIENT_BROWSER_ERROR_PATTERNS]
      .some((pattern) => pattern.test(message));
  }

  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function formatToolFailureMessage(toolResult: ToolResult) {
  const suffix = toolResult.error?.trim() ? `: ${toolResult.error.trim()}` : ".";

  if (toolResult.status === "blocked") {
    return `I couldn't finish because ${toolResult.toolName} was blocked${suffix}`;
  }

  if (toolResult.status === "error") {
    return `I couldn't finish because ${toolResult.toolName} failed${suffix}`;
  }

  return "I couldn't finish the task.";
}

function formatRetryRequiredMessage(toolResult: ToolResult) {
  return `${formatToolFailureMessage(toolResult)} Retry the failed tool execution to continue.`;
}

function isRepeatedFailedToolCall(
  lastToolResult: ToolResult | undefined,
  lastExecution: ToolExecutionRecord | null,
  toolName: string,
  args: unknown,
) {
  if (!lastToolResult || !lastExecution) {
    return false;
  }

  return (
    lastExecution.status === "error" &&
    lastExecution.retryable &&
    lastToolResult.status === "error" &&
    lastToolResult.retryable &&
    lastToolResult.toolName === toolName &&
    toStableJsonString(lastToolResult.args) === toStableJsonString(args)
  );
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
  pendingApproval?: ApprovalRequestRecord,
): Promise<ApproveRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    pendingApproval: pendingApproval ? toApprovalSummaryRecord(pendingApproval) : undefined,
    toolExecution: toolExecution ? toToolTimelineRecord(toolExecution) : undefined,
  };
}

async function executeToolAttempt({
  conversationId,
  sourceMessageId,
  toolName,
  args,
  presentation,
  riskLevel,
  retryOfExecutionId,
  onEvent,
}: {
  conversationId: string;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolResult["riskLevel"];
  retryOfExecutionId?: string | null;
  onEvent?: TurnEventSink;
}) {
  await emitPhase(onEvent, "running_tool", `Running ${toolName}`);

  const execution = await logToolExecutionStart({
    conversationId,
    sourceMessageId,
    toolName,
    args,
    presentation,
    riskLevel,
    retryOfExecutionId,
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
      retryable: false,
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
      retryable: isRetryableToolFailure(toolName, message, error),
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

async function executeToolWithRecovery({
  conversationId,
  sourceMessageId,
  toolName,
  args,
  presentation,
  riskLevel,
  retryOfExecutionId,
  onEvent,
}: {
  conversationId: string;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolResult["riskLevel"];
  retryOfExecutionId?: string | null;
  onEvent?: TurnEventSink;
}) {
  let executionResult = await executeToolAttempt({
    conversationId,
    sourceMessageId,
    toolName,
    args,
    presentation,
    riskLevel,
    retryOfExecutionId,
    onEvent,
  });

  if (
    executionResult.toolResult.status === "error" &&
    executionResult.toolResult.retryable &&
    executionResult.storedExecution
  ) {
    executionResult = await executeToolAttempt({
      conversationId,
      sourceMessageId,
      toolName,
      args,
      presentation,
      riskLevel,
      retryOfExecutionId: executionResult.storedExecution.id,
      onEvent,
    });
  }

  return executionResult;
}

async function completeTurn<T extends ChatRouteResponse | ApproveRouteResponse | RetryRouteResponse>(
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

async function requireToolRetryTurn(
  conversationId: string,
  provider: AgentProvider,
  sourceMessageId: string | null,
  toolResult: ToolResult,
  onEvent?: TurnEventSink,
) {
  await recordAssistantError({
    conversationId,
    provider,
    sourceMessageId,
    content: formatRetryRequiredMessage(toolResult),
  });
  await emitUsageUpdate(conversationId, onEvent);

  const response = await buildChatResponse(conversationId, "retry_required");

  return completeTurn(response, onEvent);
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
  initialExecution,
  onEvent,
}: {
  conversationId: string;
  provider: AgentProvider;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
  initialExecution?: ToolExecutionRecord | null;
  onEvent?: TurnEventSink;
}) {
  let lastToolResult = initialToolResult;
  let lastExecution = initialExecution ?? null;

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
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    if (isRepeatedFailedToolCall(lastToolResult, lastExecution, decision.toolName, parsedArgs)) {
      return requireToolRetryTurn(
        conversationId,
        provider,
        latestUserMessageId,
        lastToolResult!,
        onEvent,
      );
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
        retryable: false,
      };
      lastExecution = null;
      continue;
    }

    const executionResult = await executeToolWithRecovery({
      conversationId,
      sourceMessageId: latestUserMessageId,
      toolName: decision.toolName,
      args: parsedArgs,
      presentation,
      riskLevel,
      onEvent,
    });

    lastToolResult = executionResult.toolResult;
    lastExecution = executionResult.storedExecution;
  }

  if (lastToolResult && lastExecution?.status === "error" && lastExecution.retryable) {
    return requireToolRetryTurn(
      conversationId,
      provider,
      latestUserMessageId,
      lastToolResult,
      onEvent,
    );
  }

  return failTurn(
    conversationId,
    provider,
    latestUserMessageId,
    lastToolResult ? formatToolFailureMessage(lastToolResult) : "I hit the step limit before I could finish.",
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
  const executionResult = await executeToolWithRecovery({
    conversationId: updatedApproval.conversationId,
    sourceMessageId: sourceMessage?.id ?? updatedApproval.sourceMessageId,
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
    initialExecution: executionResult.storedExecution,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
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
  const executionResult = await executeToolWithRecovery({
    conversationId: updatedApproval.conversationId,
    sourceMessageId: sourceMessage?.id ?? updatedApproval.sourceMessageId,
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
    initialExecution: executionResult.storedExecution,
    onEvent,
  });
}

async function getRetryExecutionContext(toolExecutionId: string) {
  const toolExecution = await getToolExecutionById(toolExecutionId);

  if (!toolExecution) {
    throw new Error("Tool execution not found.");
  }

  if (toolExecution.status !== "error") {
    throw new Error("Only failed tool executions can be retried.");
  }

  if (!toolExecution.retryable) {
    throw new Error("This tool execution is not retryable.");
  }

  const sourceMessage = toolExecution.sourceMessageId
    ? await getMessageById(toolExecution.sourceMessageId)
    : null;
  const latestUserMessage = sourceMessage?.content ?? await getLatestUserMessage(toolExecution.conversationId);

  return {
    toolExecution,
    latestUserMessageId: sourceMessage?.id ?? toolExecution.sourceMessageId,
    latestUserMessage,
  };
}

export async function retryToolExecution({
  toolExecutionId,
  provider = getDefaultProvider(),
}: {
  toolExecutionId: string;
  provider?: AgentProvider;
}): Promise<RetryRouteResponse> {
  const retryContext = await getRetryExecutionContext(toolExecutionId);
  const executionResult = await executeToolWithRecovery({
    conversationId: retryContext.toolExecution.conversationId,
    sourceMessageId: retryContext.latestUserMessageId,
    toolName: retryContext.toolExecution.toolName,
    args: retryContext.toolExecution.args,
    presentation: retryContext.toolExecution.presentation,
    riskLevel: retryContext.toolExecution.riskLevel,
    retryOfExecutionId: retryContext.toolExecution.id,
  });

  const continuedResponse = await continueAgentLoop({
    conversationId: retryContext.toolExecution.conversationId,
    provider,
    latestUserMessageId: retryContext.latestUserMessageId,
    latestUserMessage: retryContext.latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}

export async function streamRetryToolExecution({
  toolExecutionId,
  provider = getDefaultProvider(),
  onEvent,
}: {
  toolExecutionId: string;
  provider?: AgentProvider;
  onEvent: TurnEventSink;
}) {
  const retryContext = await getRetryExecutionContext(toolExecutionId);
  const executionResult = await executeToolWithRecovery({
    conversationId: retryContext.toolExecution.conversationId,
    sourceMessageId: retryContext.latestUserMessageId,
    toolName: retryContext.toolExecution.toolName,
    args: retryContext.toolExecution.args,
    presentation: retryContext.toolExecution.presentation,
    riskLevel: retryContext.toolExecution.riskLevel,
    retryOfExecutionId: retryContext.toolExecution.id,
    onEvent,
  });

  const continuedResponse = await continueAgentLoop({
    conversationId: retryContext.toolExecution.conversationId,
    provider,
    latestUserMessageId: retryContext.latestUserMessageId,
    latestUserMessage: retryContext.latestUserMessage,
    initialToolResult: executionResult.toolResult,
    initialExecution: executionResult.storedExecution,
    onEvent,
  });

  return {
    ...continuedResponse,
    status: continuedResponse.status,
    pendingApproval: continuedResponse.pendingApproval,
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}
