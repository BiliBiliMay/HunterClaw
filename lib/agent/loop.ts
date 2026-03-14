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
  insertMessage,
  loadConversationMemory,
  logToolExecutionStart,
  maybeSummarizeConversation,
  resolveApprovalRequest,
} from "@/lib/agent/memory";
import { planNextStep } from "@/lib/agent/planner";
import { evaluateToolSafety } from "@/lib/agent/safety";
import { localProvider } from "@/lib/llm/localProvider";
import type { AgentProvider } from "@/lib/llm/provider";
import { validateToolCall } from "@/lib/tools/registry";
import { toErrorMessage } from "@/lib/utils";

const LOOP_LIMIT = 3;

async function buildChatResponse(
  conversationId: string,
  status: ChatRouteResponse["status"],
  pendingApproval?: ApprovalRequestRecord,
): Promise<ChatRouteResponse> {
  const history = await getHistoryPayload(conversationId);

  return {
    status,
    ...history,
    pendingApproval,
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
    toolExecution,
  };
}

async function executeToolAndRespond({
  conversationId,
  provider,
  toolName,
  args,
  riskLevel,
}: {
  conversationId: string;
  provider: AgentProvider;
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
  const memory = await loadConversationMemory(conversationId);
  const latestUserMessage = await getLatestUserMessage(conversationId);
  const finalDecision = await provider.generateResponse({
    conversationId,
    summary: memory.summary,
    recentMessages: memory.recentMessages,
    latestUserMessage,
    lastToolResult: toolResult,
  });

  const assistantContent =
    finalDecision.type === "message"
      ? finalDecision.content
      : "The tool finished. Ask for the next step when you are ready.";

  await insertMessage({
    conversationId,
    role: "assistant",
    kind: toolResult.status === "success" ? "text" : "error",
    content: assistantContent,
    meta: storedExecution
      ? {
          toolExecutionId: storedExecution.id,
        }
      : null,
  });

  await maybeSummarizeConversation(provider, conversationId);

  return storedExecution;
}

export async function runAgentTurn({
  message,
  conversationId = DEFAULT_CONVERSATION_ID,
  provider = localProvider,
}: {
  message: string;
  conversationId?: string;
  provider?: AgentProvider;
}): Promise<ChatRouteResponse> {
  await insertMessage({
    conversationId,
    role: "user",
    content: message,
  });

  let lastToolResult: ToolResult | undefined;

  for (let index = 0; index < LOOP_LIMIT; index += 1) {
    const memory = await loadConversationMemory(conversationId);
    const decision = await planNextStep(provider, {
      conversationId,
      summary: memory.summary,
      recentMessages: memory.recentMessages,
      latestUserMessage: message,
      lastToolResult,
    });

    if (decision.type === "message") {
      await insertMessage({
        conversationId,
        role: "assistant",
        kind: "text",
        content: decision.content,
      });
      await maybeSummarizeConversation(provider, conversationId);
      return buildChatResponse(conversationId, "completed");
    }

    const { tool, parsedArgs } = validateToolCall(decision.toolName, decision.args);
    const riskLevel = tool.getRiskLevel(parsedArgs);
    const safety = await evaluateToolSafety(decision.toolName, parsedArgs, riskLevel);

    if (safety.requiresApproval) {
      const pendingApproval = await createApprovalRequest({
        conversationId,
        toolName: decision.toolName,
        args: parsedArgs,
        riskLevel,
        reason: decision.reason,
      });
      await maybeSummarizeConversation(provider, conversationId);
      return buildChatResponse(conversationId, "approval_required", pendingApproval);
    }

    const storedExecution = await executeToolAndRespond({
      conversationId,
      provider,
      toolName: decision.toolName,
      args: parsedArgs,
      riskLevel,
    });

    lastToolResult = storedExecution
      ? {
          toolName: storedExecution.toolName,
          args: storedExecution.args,
          riskLevel: storedExecution.riskLevel,
          status: storedExecution.status === "running" ? "error" : storedExecution.status,
          output: storedExecution.result as ToolResult["output"],
          error: storedExecution.error,
        }
      : undefined;

    return buildChatResponse(conversationId, "completed");
  }

  await insertMessage({
    conversationId,
    role: "assistant",
    kind: "error",
    content: "The agent stopped after reaching the loop limit.",
  });

  return buildChatResponse(conversationId, "error");
}

export async function handleApprovalDecision({
  requestId,
  decision,
  provider = localProvider,
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
    await maybeSummarizeConversation(provider, updatedApproval.conversationId);
    return buildApproveResponse(updatedApproval.conversationId, "denied");
  }

  const storedExecution = await executeToolAndRespond({
    conversationId: updatedApproval.conversationId,
    provider,
    toolName: updatedApproval.toolName,
    args: updatedApproval.args,
    riskLevel: updatedApproval.riskLevel,
  });

  return buildApproveResponse(updatedApproval.conversationId, "completed", storedExecution ?? undefined);
}

