import { asc, desc, eq } from "drizzle-orm";

import { deriveConversationTitle, NEW_CHAT_TITLE } from "@/lib/agent/conversations";
import type {
  ApprovalRequestRecord,
  ApprovalSummaryRecord,
  ChatMessage,
  ChatRole,
  ConversationListItem,
  ConversationUsageSummary,
  HistoryPayload,
  JsonRecord,
  LlmUsageEvent,
  MessageKind,
  ProviderUsage,
  ToolTimelineRecord,
  ToolExecutionRecord,
  ToolResult,
  UsageTotals,
} from "@/lib/agent/types";
import {
  toApprovalSummaryRecord,
  toToolTimelineRecord,
} from "@/lib/agent/presentation";
import { db } from "@/lib/db/client";
import {
  approvalRequests,
  conversations,
  llmUsageEvents,
  messages,
  preferences,
  summaries,
  toolExecutions,
} from "@/lib/db/schema";
import type { AgentProvider } from "@/lib/llm/provider";
import { createId, nowIso, safeJsonParse, toJsonString } from "@/lib/utils";

const SUMMARY_TRIGGER_COUNT = 12;
const RECENT_RAW_MESSAGES = 8;
const RECENT_TOOL_EXECUTIONS = 6;

function createEmptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    knownEvents: 0,
    unknownEvents: 0,
  };
}

function parseTokenValue(value: string | null) {
  if (!value) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

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
    sourceMessageId: row.sourceMessageId,
    toolName: row.toolName,
    args: safeJsonParse(row.argsJson, null),
    riskLevel: row.riskLevel as ApprovalRequestRecord["riskLevel"],
    status: row.status as ApprovalRequestRecord["status"],
    reason: row.reason,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function mapLlmUsageRow(row: typeof llmUsageEvents.$inferSelect): LlmUsageEvent {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sourceMessageId: row.sourceMessageId,
    providerName: row.providerName,
    modelName: row.modelName,
    operation: row.operation as LlmUsageEvent["operation"],
    inputTokens: parseTokenValue(row.inputTokens),
    outputTokens: parseTokenValue(row.outputTokens),
    totalTokens: parseTokenValue(row.totalTokens),
    createdAt: row.createdAt,
  };
}

function aggregateUsage(rows: LlmUsageEvent[]): UsageTotals {
  const totals = createEmptyUsageTotals();

  for (const row of rows) {
    if (row.inputTokens != null) {
      totals.inputTokens += row.inputTokens;
    }

    if (row.outputTokens != null) {
      totals.outputTokens += row.outputTokens;
    }

    if (row.totalTokens != null) {
      totals.totalTokens += row.totalTokens;
      totals.knownEvents += 1;
    } else {
      totals.unknownEvents += 1;
    }
  }

  return totals;
}

function mapConversationRow(row: typeof conversations.$inferSelect): ConversationListItem {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function ensureConversationRecord(
  conversationId: string,
  createdAt: string = nowIso(),
) {
  db.insert(conversations)
    .values({
      id: conversationId,
      title: NEW_CHAT_TITLE,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing()
    .run();
}

async function touchConversation(conversationId: string, updatedAt: string = nowIso()) {
  await ensureConversationRecord(conversationId, updatedAt);

  db.update(conversations)
    .set({
      updatedAt,
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

async function maybeUpdateConversationTitleFromFirstUserMessage(
  conversationId: string,
  content: string,
  updatedAt: string,
) {
  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
    .all()[0];

  if (!conversation || conversation.title !== NEW_CHAT_TITLE) {
    return;
  }

  const userMessages = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all()
    .filter((message) => message.role === "user");

  if (userMessages.length !== 1) {
    return;
  }

  db.update(conversations)
    .set({
      title: deriveConversationTitle(content),
      updatedAt,
    })
    .where(eq(conversations.id, conversationId))
    .run();
}

export async function createConversation() {
  const createdAt = nowIso();
  const conversation: ConversationListItem = {
    id: createId("conversation"),
    title: NEW_CHAT_TITLE,
    createdAt,
    updatedAt: createdAt,
  };

  db.insert(conversations)
    .values({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    })
    .run();

  return conversation;
}

export async function listConversations() {
  const rows = db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
    .all();

  return rows.map(mapConversationRow);
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

  await ensureConversationRecord(conversationId, message.createdAt);

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

  await touchConversation(conversationId, message.createdAt);

  if (role === "user") {
    await maybeUpdateConversationTitleFromFirstUserMessage(
      conversationId,
      content,
      message.createdAt,
    );
  }

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
  const recentToolExecutionRows = db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.conversationId, conversationId))
    .orderBy(desc(toolExecutions.createdAt))
    .limit(RECENT_TOOL_EXECUTIONS)
    .all()
    .reverse();

  return {
    conversationId,
    summary: summaryRow?.content ?? null,
    recentMessages,
    recentToolExecutions: recentToolExecutionRows.map(mapToolExecutionRow),
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

export async function getMessageById(messageId: string) {
  const row = db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
    .all()[0];

  return row ? mapMessageRow(row) : null;
}

export async function logLlmUsageEvent({
  conversationId,
  sourceMessageId,
  usage,
}: {
  conversationId: string;
  sourceMessageId: string | null;
  usage: ProviderUsage;
}) {
  const event: LlmUsageEvent = {
    id: createId("usage"),
    conversationId,
    sourceMessageId,
    providerName: usage.providerName,
    modelName: usage.modelName,
    operation: usage.operation,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    createdAt: nowIso(),
  };

  await ensureConversationRecord(conversationId, event.createdAt);

  db.insert(llmUsageEvents)
    .values({
      id: event.id,
      conversationId: event.conversationId,
      sourceMessageId: event.sourceMessageId,
      providerName: event.providerName,
      modelName: event.modelName,
      operation: event.operation,
      inputTokens: event.inputTokens != null ? String(event.inputTokens) : null,
      outputTokens: event.outputTokens != null ? String(event.outputTokens) : null,
      totalTokens: event.totalTokens != null ? String(event.totalTokens) : null,
      createdAt: event.createdAt,
    })
    .run();

  return event;
}

export async function maybeSummarizeConversation(
  provider: AgentProvider,
  conversationId: string,
  sourceMessageId: string | null = null,
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

  let summaryResult;

  try {
    summaryResult = await provider.summarize({
      conversationId,
      previousSummary: summaryRow?.content ?? null,
      messages: messagesToSummarize,
    });
  } catch (error) {
    console.warn("Skipping memory summarization after provider error:", error);
    return null;
  }

  await logLlmUsageEvent({
    conversationId,
    sourceMessageId,
    usage: summaryResult.usage,
  });

  const summaryContent = summaryResult.summary;
  if (!summaryContent.trim()) {
    return null;
  }

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
  sourceMessageId,
  toolName,
  args,
  riskLevel,
  reason,
}: {
  conversationId: string;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  riskLevel: ApprovalRequestRecord["riskLevel"];
  reason: string;
}) {
  const approvalRequest: ApprovalRequestRecord = {
    id: createId("approval"),
    conversationId,
    sourceMessageId,
    toolName,
    args,
    riskLevel,
    status: "pending",
    reason,
    createdAt: nowIso(),
    resolvedAt: null,
  };

  await ensureConversationRecord(conversationId, approvalRequest.createdAt);

  db.insert(approvalRequests)
    .values({
      id: approvalRequest.id,
      conversationId,
      sourceMessageId,
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

  await ensureConversationRecord(conversationId, execution.createdAt);

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

async function buildConversationUsageSummary(
  conversationId: string,
  mappedMessages: ChatMessage[],
) {
  const usageRows = db
    .select()
    .from(llmUsageEvents)
    .where(eq(llmUsageEvents.conversationId, conversationId))
    .orderBy(asc(llmUsageEvents.createdAt))
    .all()
    .map(mapLlmUsageRow);

  const latestUserMessage = [...mappedMessages].reverse().find((message) => message.role === "user");
  const lastTurnUsageRows = latestUserMessage
    ? usageRows.filter((row) => row.sourceMessageId === latestUserMessage.id)
    : [];

  return {
    totals: aggregateUsage(usageRows),
    lastTurn: latestUserMessage ? aggregateUsage(lastTurnUsageRows) : null,
  };
}

export async function getConversationUsageSummary(
  conversationId: string,
): Promise<ConversationUsageSummary> {
  const mappedMessages = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map(mapMessageRow);

  return buildConversationUsageSummary(conversationId, mappedMessages);
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
  const mappedMessages = messageRows.map(mapMessageRow);
  const rawToolExecutions = toolRows.map(mapToolExecutionRow);
  const rawApprovals = approvalRows.map(mapApprovalRow);
  const usage = await buildConversationUsageSummary(conversationId, mappedMessages);

  return {
    messages: mappedMessages,
    toolExecutions: rawToolExecutions.map(toToolTimelineRecord),
    pendingApprovals: rawApprovals.map(toApprovalSummaryRecord),
    usage,
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
