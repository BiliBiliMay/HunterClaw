import type {
  ApprovalRequestRecord,
  ApproveRouteResponse,
  ChatRouteResponse,
  ToolExecutionRecord,
  ToolResult,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import {
  createApprovalRequest,
  finishToolExecution,
  getApprovalRequest,
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
import { validateToolCall } from "@/lib/tools/registry";
import { toErrorMessage } from "@/lib/utils";

const LOOP_LIMIT = 8;

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
  riskLevel,
}: {
  conversationId: string;
  toolName: string;
  args: unknown;
  riskLevel: ToolResult["riskLevel"];
}) {
  const execution = await logToolExecutionStart({
    conversationId,
    toolName,
    args,
    riskLevel,
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

  const storedExecution = await finishToolExecution(execution.id, toolResult);

  return {
    storedExecution,
    toolResult,
  };
}

async function continueAgentLoop({
  conversationId,
  provider,
  latestUserMessageId,
  latestUserMessage,
  initialToolResult,
}: {
  conversationId: string;
  provider: AgentProvider;
  latestUserMessageId: string | null;
  latestUserMessage: string;
  initialToolResult?: ToolResult;
}) {
  let lastToolResult = initialToolResult;

  for (let index = 0; index < LOOP_LIMIT; index += 1) {
    const memory = await loadConversationMemory(conversationId);
    let decisionResult;

    try {
      decisionResult = await planNextStep(provider, {
        conversationId,
        summary: memory.summary,
        recentMessages: memory.recentMessages,
        recentToolExecutions: memory.recentToolExecutions,
        latestUserMessage,
        lastToolResult,
        stepIndex: index + 1,
      });
      await logLlmUsageEvent({
        conversationId,
        sourceMessageId: latestUserMessageId,
        usage: decisionResult.usage,
      });
    } catch (error) {
      await recordAssistantError({
        conversationId,
        provider,
        sourceMessageId: latestUserMessageId,
        content: `I couldn't plan the next step because ${toErrorMessage(error)}`,
      });
      return buildChatResponse(conversationId, "error");
    }

    const decision = decisionResult.decision;

    if (decision.type === "message") {
      await insertMessage({
        conversationId,
        role: "assistant",
        kind: "text",
        content: decision.content,
      });
      await maybeSummarizeConversation(provider, conversationId, latestUserMessageId);
      return buildChatResponse(conversationId, "completed");
    }

    let tool;
    let parsedArgs;
    let riskLevel: ToolResult["riskLevel"];

    try {
      const validatedToolCall = validateToolCall(decision.toolName, decision.args);
      tool = validatedToolCall.tool;
      parsedArgs = validatedToolCall.parsedArgs;
      riskLevel = tool.getRiskLevel(parsedArgs);
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

    let safety;

    try {
      safety = await evaluateToolSafety(decision.toolName, parsedArgs, riskLevel);
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

    if (safety.requiresApproval) {
      const pendingApproval = await createApprovalRequest({
        conversationId,
        sourceMessageId: latestUserMessageId,
        toolName: decision.toolName,
        args: parsedArgs,
        riskLevel,
        reason: decision.reason,
      });
      await maybeSummarizeConversation(provider, conversationId, latestUserMessageId);
      return buildChatResponse(conversationId, "approval_required", pendingApproval);
    }

    const executionResult = await executeTool({
      conversationId,
      toolName: decision.toolName,
      args: parsedArgs,
      riskLevel,
    });

    lastToolResult = executionResult.toolResult;
  }

  await recordAssistantError({
    conversationId,
    provider,
    sourceMessageId: latestUserMessageId,
    content: "I hit the step limit before I could finish. Ask me to continue or narrow the task.",
  });

  return buildChatResponse(conversationId, "error");
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
    status: "completed",
    toolExecution: executionResult.storedExecution
      ? toToolTimelineRecord(executionResult.storedExecution)
      : undefined,
  };
}
