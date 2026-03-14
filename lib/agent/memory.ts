import { asc, desc, eq } from "drizzle-orm";

import type {
  ApprovalRequestRecord,
  ChatMessage,
  ChatRole,
  HistoryPayload,
  JsonRecord,
  MessageKind,
  ToolExecutionRecord,
  ToolResult,
} from "@/lib/agent/types";
import { db } from "@/lib/db/client";
import {
  approvalRequests,
  messages,
  preferences,
  summaries,
  toolExecutions,
} from "@/lib/db/schema";
import type { AgentProvider } from "@/lib/llm/provider";
import { createId, nowIso, safeJsonParse, toJsonString } from "@/lib/utils";

const SUMMARY_TRIGGER_COUNT = 12;
const RECENT_RAW_MESSAGES = 8;

function mapMessageRow(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ChatRole,
    kind: row.kind as MessageKind,
    content: row.content,
    meta: safeJsonParse<JsonRecord | null>(row.metaJson, null),
    createdAt: row.createdAt,
  };
}

function mapToolExecutionRow(row: typeof toolExecutions.$inferSelect): ToolExecutionRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    toolName: row.toolName,
    args: safeJsonParse(row.argsJson, null),
    riskLevel: row.riskLevel as ToolExecutionRecord["riskLevel"],
    status: row.status as ToolExecutionRecord["status"],
    result: safeJsonParse(row.resultJson, null),
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function mapApprovalRow(row: typeof approvalRequests.$inferSelect): ApprovalRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    toolName: row.toolName,
    args: safeJsonParse(row.argsJson, null),
    riskLevel: row.riskLevel as ApprovalRequestRecord["riskLevel"],
    status: row.status as ApprovalRequestRecord["status"],
    reason: row.reason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function insertMessage({
  conversationId,
  role,
  kind = "text",
  content,
  meta = null,
}: {
  conversationId: string;
  role: ChatRole;
  kind?: MessageKind;
  content: string;
  meta?: JsonRecord | null;
}) {
  const message: ChatMessage = {
    id: createId("msg"),
    conversationId,
    role,
    kind,
    content,
    meta,
    createdAt: nowIso(),
  };

  db.insert(messages)
    .values({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      kind: message.kind,
      content: message.content,
      metaJson: meta ? toJsonString(meta) : null,
      createdAt: message.createdAt,
    })
    .run();

  return message;
}

export async function getLatestSummary(conversationId: string) {
  const row = db
    .select()
    .from(summaries)
    .where(eq(summaries.conversationId, conversationId))
    .orderBy(desc(summaries.createdAt))
    .limit(1)
    .all()[0];

  return row ?? null;
}

export async function loadConversationMemory(conversationId: string) {
  const summaryRow = await getLatestSummary(conversationId);
  const messageRows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();

  const mappedMessages = messageRows.map(mapMessageRow);
  const cutoffIndex = summaryRow
    ? mappedMessages.findIndex((message) => message.id === summaryRow.lastMessageId)
    : -1;
  const recentMessages = mappedMessages.slice(cutoffIndex + 1).slice(-RECENT_RAW_MESSAGES);

  return {
    conversationId,
    summary: summaryRow?.content ?? null,
    recentMessages,
  };
}

export async function getLatestUserMessage(conversationId: string) {
  const row = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .all()
    .find((message) => message.role === "user");

  return row?.content ?? "";
}

export async function maybeSummarizeConversation(
  provider: AgentProvider,
  conversationId: string,
) {
  if (!provider.summarize) {
    return null;
  }

  const summaryRow = await getLatestSummary(conversationId);
  const messageRows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
  const mappedMessages = messageRows.map(mapMessageRow);
  const cutoffIndex = summaryRow
    ? mappedMessages.findIndex((message) => message.id === summaryRow.lastMessageId)
    : -1;
  const unsummarizedMessages = mappedMessages.slice(cutoffIndex + 1);

  if (unsummarizedMessages.length < SUMMARY_TRIGGER_COUNT) {
    return null;
  }

  // Preserve the newest raw messages so the provider still sees recent turn-by-turn context.
  const messagesToSummarize = unsummarizedMessages.slice(0, unsummarizedMessages.length - RECENT_RAW_MESSAGES);
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const summaryContent = await provider.summarize({
    conversationId,
    previousSummary: summaryRow?.content ?? null,
    messages: messagesToSummarize,
  });
  const lastMessage = messagesToSummarize[messagesToSummarize.length - 1];

  db.insert(summaries)
    .values({
      id: createId("summary"),
      conversationId,
      content: summaryContent,
      lastMessageId: lastMessage.id,
      createdAt: nowIso(),
    })
    .run();

  return summaryContent;
}

export async function createApprovalRequest({
  conversationId,
  toolName,
  args,
  riskLevel,
  reason,
}: {
  conversationId: string;
  toolName: string;
  args: unknown;
  riskLevel: ApprovalRequestRecord["riskLevel"];
  reason: string;
}) {
  const approvalRequest: ApprovalRequestRecord = {
    id: createId("approval"),
    conversationId,
    toolName,
    args,
    riskLevel,
    status: "pending",
    reason,
    createdAt: nowIso(),
    resolvedAt: null,
  };

  db.insert(approvalRequests)
    .values({
      id: approvalRequest.id,
      conversationId,
      toolName,
      argsJson: toJsonString(args),
      riskLevel,
      status: approvalRequest.status,
      reason,
      createdAt: approvalRequest.createdAt,
      resolvedAt: null,
    })
    .run();

  return approvalRequest;
}

export async function getApprovalRequest(requestId: string) {
  const row = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId))
    .limit(1)
    .all()[0];

  return row ? mapApprovalRow(row) : null;
}

export async function resolveApprovalRequest(
  requestId: string,
  status: ApprovalRequestRecord["status"],
) {
  const resolvedAt = nowIso();

  db.update(approvalRequests)
    .set({
      status,
      resolvedAt,
    })
    .where(eq(approvalRequests.id, requestId))
    .run();

  const updatedRow = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId))
    .limit(1)
    .all()[0];

  return updatedRow ? mapApprovalRow(updatedRow) : null;
}

export async function logToolExecutionStart({
  conversationId,
  toolName,
  args,
  riskLevel,
}: {
  conversationId: string;
  toolName: string;
  args: unknown;
  riskLevel: ToolExecutionRecord["riskLevel"];
}) {
  const execution: ToolExecutionRecord = {
    id: createId("tool"),
    conversationId,
    toolName,
    args,
    riskLevel,
    status: "running",
    result: null,
    error: null,
    createdAt: nowIso(),
    finishedAt: null,
  };

  db.insert(toolExecutions)
    .values({
      id: execution.id,
      conversationId,
      toolName,
      argsJson: toJsonString(args),
      riskLevel,
      status: execution.status,
      resultJson: null,
      error: null,
      createdAt: execution.createdAt,
      finishedAt: null,
    })
    .run();

  return execution;
}

export async function finishToolExecution(
  executionId: string,
  result: ToolResult,
) {
  const finishedAt = nowIso();

  db.update(toolExecutions)
    .set({
      status: result.status,
      resultJson: toJsonString(result.output),
      error: result.error,
      finishedAt,
    })
    .where(eq(toolExecutions.id, executionId))
    .run();

  const row = db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.id, executionId))
    .limit(1)
    .all()[0];

  return row ? mapToolExecutionRow(row) : null;
}

export async function getHistoryPayload(conversationId: string): Promise<HistoryPayload> {
  const messageRows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();
  const toolRows = db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.conversationId, conversationId))
    .orderBy(asc(toolExecutions.createdAt))
    .all();
  const approvalRows = db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.conversationId, conversationId))
    .orderBy(asc(approvalRequests.createdAt))
    .all()
    .filter((row) => row.status === "pending");

  return {
    messages: messageRows.map(mapMessageRow),
    toolExecutions: toolRows.map(mapToolExecutionRow),
    pendingApprovals: approvalRows.map(mapApprovalRow),
  };
}

export async function getPreference(key: string) {
  const row = db
    .select()
    .from(preferences)
    .where(eq(preferences.key, key))
    .limit(1)
    .all()[0];

  return row?.value ?? null;
}
