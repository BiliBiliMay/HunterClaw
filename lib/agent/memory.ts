import { asc, desc, eq } from "drizzle-orm";

import { deriveConversationTitle, NEW_CHAT_TITLE } from "@/lib/agent/conversations";
import type {
  AgentRole,
  AgentRunRecord,
  AgentRunStatus,
  ApprovalRequestRecord,
  ApprovalSummaryRecord,
  ChatMessage,
  ChatRole,
  ConversationSummary,
  ConversationUsageSummary,
  ExecutorContext,
  ExecutorRunInput,
  HistoryPayload,
  JsonRecord,
  LlmUsageEvent,
  MessageKind,
  PlannerContext,
  PlannerRunInput,
  ProviderUsage,
  SubAgentResult,
  SubAgentResultRecord,
  ToolPresentationDetails,
  ToolTimelineRecord,
  ToolExecutionRecord,
  ToolResult,
  UsageTotals,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import {
  toApprovalSummaryRecord,
  toToolTimelineRecord,
} from "@/lib/agent/presentation";
import {
  createDefaultApprovalPreferences,
  isApprovalPreferenceKey,
  type ApprovalPreferenceKey,
  type ApprovalPreferences,
} from "@/lib/agent/approvalPreferences";
import { db } from "@/lib/db/client";
import {
  approvalRequests,
  agentRuns,
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
const RECENT_EXECUTOR_RESULTS = 4;
const CONVERSATION_TITLE_MAX_LENGTH = 48;
const CONVERSATION_PREVIEW_MAX_LENGTH = 96;

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

function truncateInlineText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
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
    agentRunId: row.agentRunId,
    agentRole: null,
    sourceMessageId: row.sourceMessageId,
    toolName: row.toolName,
    args: safeJsonParse(row.argsJson, null),
    presentation: safeJsonParse<ToolPresentationDetails | null>(row.presentationJson, null),
    riskLevel: row.riskLevel as ToolExecutionRecord["riskLevel"],
    status: row.status as ToolExecutionRecord["status"],
    result: safeJsonParse(row.resultJson, null),
    error: row.error,
    retryable: row.retryable,
    retryOfExecutionId: row.retryOfExecutionId,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function mapApprovalRow(row: typeof approvalRequests.$inferSelect): ApprovalRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    agentRunId: row.agentRunId,
    sourceMessageId: row.sourceMessageId,
    toolName: row.toolName,
    args: safeJsonParse(row.argsJson, null),
    presentation: safeJsonParse<ToolPresentationDetails | null>(row.presentationJson, null),
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

function mapAgentRunRow(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    parentRunId: row.parentRunId,
    sourceMessageId: row.sourceMessageId,
    role: row.role as AgentRunRecord["role"],
    status: row.status as AgentRunRecord["status"],
    input: safeJsonParse<unknown>(row.inputJson, null),
    result: safeJsonParse<unknown>(row.resultJson, null),
    lastToolExecutionId: row.lastToolExecutionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function normalizeAgentRole(value: string | null | undefined): AgentRole | null {
  if (value === "planner" || value === "executor") {
    return value;
  }

  return null;
}

function parseSubAgentResult(value: unknown): SubAgentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const keyArtifacts = Array.isArray(record.keyArtifacts)
    ? record.keyArtifacts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const lastToolResult =
    record.lastToolResult && typeof record.lastToolResult === "object" && !Array.isArray(record.lastToolResult)
      ? (record.lastToolResult as SubAgentResult["lastToolResult"])
      : null;

  return {
    summary,
    keyArtifacts,
    lastToolResult,
  };
}

async function loadAgentRoleMap(runIds: string[]) {
  const uniqueRunIds = [...new Set(runIds.filter((runId): runId is string => Boolean(runId)))];
  if (uniqueRunIds.length === 0) {
    return new Map<string, AgentRole>();
  }

  const runIdSet = new Set(uniqueRunIds);
  const rows = db
    .select()
    .from(agentRuns)
    .all()
    .filter((row) => runIdSet.has(row.id));

  return new Map<string, AgentRole>(
    rows
      .map((row) => [row.id, normalizeAgentRole(row.role)] as const)
      .filter((entry): entry is readonly [string, AgentRole] => entry[1] != null),
  );
}

async function attachAgentRolesToToolExecutions(records: ToolExecutionRecord[]) {
  const roleMap = await loadAgentRoleMap(records.map((record) => record.agentRunId ?? ""));

  return records.map((record) => ({
    ...record,
    agentRole: record.agentRunId ? roleMap.get(record.agentRunId) ?? null : "planner",
  }));
}

async function buildRecentConversationMessages(conversationId: string) {
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

  return {
    summary: summaryRow?.content ?? null,
    recentMessages: mappedMessages.slice(cutoffIndex + 1).slice(-RECENT_RAW_MESSAGES),
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

function createConversationSummarySeed(row?: typeof conversations.$inferSelect) {
  const storedTitle = row?.title?.trim() ?? "";

  return {
    id: row?.id ?? "",
    titleSeed: storedTitle && storedTitle !== NEW_CHAT_TITLE ? storedTitle : null,
    titleFromUser: storedTitle !== "" && storedTitle !== NEW_CHAT_TITLE,
    preview: null as string | null,
    createdAt: row?.createdAt ?? null,
    lastActivityAt: row && row.updatedAt !== row.createdAt ? row.updatedAt : null,
    messageCount: 0,
    pendingApprovalCount: 0,
  };
}

function getConversationFallbackTitle(conversationId: string) {
  if (conversationId === DEFAULT_CONVERSATION_ID) {
    return "Default conversation";
  }

  return NEW_CHAT_TITLE;
}

function touchConversationActivity(
  conversation: ReturnType<typeof createConversationSummarySeed>,
  timestamp: string,
) {
  if (!conversation.createdAt || timestamp < conversation.createdAt) {
    conversation.createdAt = timestamp;
  }

  if (!conversation.lastActivityAt || timestamp > conversation.lastActivityAt) {
    conversation.lastActivityAt = timestamp;
  }
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

export async function createConversation(): Promise<ConversationSummary> {
  const createdAt = nowIso();
  const conversationId = createId("conversation");

  db.insert(conversations)
    .values({
      id: conversationId,
      title: NEW_CHAT_TITLE,
      createdAt,
      updatedAt: createdAt,
    })
    .run();

  return {
    id: conversationId,
    title: NEW_CHAT_TITLE,
    preview: null,
    createdAt,
    lastActivityAt: null,
    messageCount: 0,
    pendingApprovalCount: 0,
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
  const { summary, recentMessages } = await buildRecentConversationMessages(conversationId);
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
    summary,
    recentMessages,
    recentToolExecutions: await attachAgentRolesToToolExecutions(
      recentToolExecutionRows.map(mapToolExecutionRow),
    ),
  };
}

export async function createAgentRun({
  conversationId,
  parentRunId = null,
  sourceMessageId = null,
  role,
  input,
}: {
  conversationId: string;
  parentRunId?: string | null;
  sourceMessageId?: string | null;
  role: AgentRunRecord["role"];
  input: PlannerRunInput | ExecutorRunInput;
}) {
  const timestamp = nowIso();
  const run: AgentRunRecord = {
    id: createId("run"),
    conversationId,
    parentRunId,
    sourceMessageId,
    role,
    status: "running",
    input,
    result: null,
    lastToolExecutionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: null,
  };

  await ensureConversationRecord(conversationId, timestamp);

  db.insert(agentRuns)
    .values({
      id: run.id,
      conversationId,
      parentRunId,
      sourceMessageId,
      role,
      status: run.status,
      inputJson: toJsonString(input),
      resultJson: null,
      lastToolExecutionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    })
    .run();

  return run;
}

export async function getAgentRunById(runId: string) {
  const row = db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1)
    .all()[0];

  return row ? mapAgentRunRow(row) : null;
}

export async function updateAgentRun({
  runId,
  status,
  result,
  lastToolExecutionId,
  finishedAt,
}: {
  runId: string;
  status?: AgentRunStatus;
  result?: unknown;
  lastToolExecutionId?: string | null;
  finishedAt?: string | null;
}) {
  const updatedAt = nowIso();
  const nextFinishedAt = finishedAt === undefined
    ? status === "completed" || status === "error"
      ? updatedAt
      : undefined
    : finishedAt;

  db.update(agentRuns)
    .set({
      ...(status !== undefined ? { status } : {}),
      ...(result !== undefined ? { resultJson: result == null ? null : toJsonString(result) } : {}),
      ...(lastToolExecutionId !== undefined ? { lastToolExecutionId } : {}),
      ...(nextFinishedAt !== undefined ? { finishedAt: nextFinishedAt } : {}),
      updatedAt,
    })
    .where(eq(agentRuns.id, runId))
    .run();

  return getAgentRunById(runId);
}

export async function listExecutorResultsForPlanner({
  conversationId,
  sourceMessageId,
}: {
  conversationId: string;
  sourceMessageId: string | null;
}): Promise<SubAgentResultRecord[]> {
  const rows = db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId))
    .orderBy(desc(agentRuns.createdAt))
    .all()
    .filter((row) => {
      if (row.role !== "executor" || row.status !== "completed" || !row.resultJson) {
        return false;
      }

      if (sourceMessageId && row.sourceMessageId !== sourceMessageId) {
        return false;
      }

      return true;
    })
    .slice(0, RECENT_EXECUTOR_RESULTS)
    .reverse();

  return rows
    .map((row) => {
      const result = parseSubAgentResult(safeJsonParse<unknown>(row.resultJson, null));
      if (!result) {
        return null;
      }

      return {
        ...result,
        runId: row.id,
        createdAt: row.createdAt,
      };
    })
    .filter((result): result is SubAgentResultRecord => result != null);
}

export async function loadPlannerContext({
  conversationId,
  sourceMessageId,
  latestUserMessage,
  lastToolResult,
  stepIndex,
}: {
  conversationId: string;
  sourceMessageId: string | null;
  latestUserMessage: string;
  lastToolResult?: ToolResult;
  stepIndex: number;
}): Promise<PlannerContext> {
  const { summary, recentMessages } = await buildRecentConversationMessages(conversationId);
  const candidateToolRows = db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.conversationId, conversationId))
    .orderBy(desc(toolExecutions.createdAt))
    .all();
  const candidateToolExecutions = await attachAgentRolesToToolExecutions(
    candidateToolRows.map(mapToolExecutionRow),
  );
  const recentToolExecutions = candidateToolExecutions
    .filter((record) => {
      if (sourceMessageId && record.sourceMessageId !== sourceMessageId) {
        return false;
      }

      return record.agentRole !== "executor";
    })
    .slice(0, RECENT_TOOL_EXECUTIONS)
    .reverse();

  return {
    role: "planner",
    conversationId,
    sourceMessageId,
    summary,
    recentMessages,
    recentToolExecutions,
    recentExecutorResults: await listExecutorResultsForPlanner({
      conversationId,
      sourceMessageId,
    }),
    latestUserMessage,
    lastToolResult,
    stepIndex,
  };
}

export async function loadExecutorContext({
  runId,
  latestUserMessage,
  lastToolResult,
  stepIndex,
}: {
  runId: string;
  latestUserMessage: string;
  lastToolResult?: ToolResult;
  stepIndex: number;
}): Promise<ExecutorContext> {
  const run = await getAgentRunById(runId);
  if (!run) {
    throw new Error("Agent run not found.");
  }

  const input = (run.input ?? null) as ExecutorRunInput | null;
  if (run.role !== "executor" || !input?.task || !input.successCriteria) {
    throw new Error("Executor run is missing its delegated task input.");
  }

  const { summary, recentMessages } = await buildRecentConversationMessages(run.conversationId);
  const recentToolExecutions = await attachAgentRolesToToolExecutions(
    db
      .select()
      .from(toolExecutions)
      .where(eq(toolExecutions.agentRunId, runId))
      .orderBy(desc(toolExecutions.createdAt))
      .limit(RECENT_TOOL_EXECUTIONS)
      .all()
      .reverse()
      .map(mapToolExecutionRow),
  );

  return {
    role: "executor",
    conversationId: run.conversationId,
    sourceMessageId: run.sourceMessageId,
    summary,
    recentMessages,
    recentToolExecutions,
    latestUserMessage,
    delegatedTask: input.task,
    successCriteria: input.successCriteria,
    notes: input.notes ?? null,
    lastToolResult,
    stepIndex,
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
  agentRunId = null,
  sourceMessageId,
  toolName,
  args,
  presentation = null,
  riskLevel,
  reason,
}: {
  conversationId: string;
  agentRunId?: string | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ApprovalRequestRecord["riskLevel"];
  reason: string;
}) {
  const approvalRequest: ApprovalRequestRecord = {
    id: createId("approval"),
    conversationId,
    agentRunId,
    sourceMessageId,
    toolName,
    args,
    presentation,
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
      agentRunId,
      sourceMessageId,
      toolName,
      argsJson: toJsonString(args),
      presentationJson: presentation ? toJsonString(presentation) : null,
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
  agentRunId = null,
  sourceMessageId,
  toolName,
  args,
  presentation = null,
  riskLevel,
  retryOfExecutionId = null,
}: {
  conversationId: string;
  agentRunId?: string | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation?: ToolPresentationDetails | null;
  riskLevel: ToolExecutionRecord["riskLevel"];
  retryOfExecutionId?: string | null;
}) {
  const agentRole = agentRunId
    ? (await getAgentRunById(agentRunId))?.role ?? null
    : "planner";
  const execution: ToolExecutionRecord = {
    id: createId("tool"),
    conversationId,
    agentRunId,
    agentRole,
    sourceMessageId,
    toolName,
    args,
    presentation,
    riskLevel,
    status: "running",
    result: null,
    error: null,
    retryable: false,
    retryOfExecutionId,
    createdAt: nowIso(),
    finishedAt: null,
  };

  await ensureConversationRecord(conversationId, execution.createdAt);

  db.insert(toolExecutions)
    .values({
      id: execution.id,
      conversationId,
      agentRunId,
      sourceMessageId,
      toolName,
      argsJson: toJsonString(args),
      presentationJson: presentation ? toJsonString(presentation) : null,
      riskLevel,
      status: execution.status,
      resultJson: null,
      error: null,
      retryable: false,
      retryOfExecutionId,
      createdAt: execution.createdAt,
      finishedAt: null,
    })
    .run();

  if (agentRunId) {
    await updateAgentRun({
      runId: agentRunId,
      lastToolExecutionId: execution.id,
    });
  }

  return execution;
}

export async function finishToolExecution(
  executionId: string,
  result: ToolResult,
  presentation?: ToolPresentationDetails | null,
) {
  const finishedAt = nowIso();

  db.update(toolExecutions)
    .set({
      status: result.status,
      resultJson: toJsonString(result.output),
      ...(presentation !== undefined
        ? {
            presentationJson: presentation ? toJsonString(presentation) : null,
          }
        : {}),
      error: result.error,
      retryable: result.retryable,
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

  if (!row) {
    return null;
  }

  const [mappedRow] = await attachAgentRolesToToolExecutions([mapToolExecutionRow(row)]);
  return mappedRow ?? null;
}

export async function getToolExecutionById(executionId: string) {
  const row = db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.id, executionId))
    .limit(1)
    .all()[0];

  if (!row) {
    return null;
  }

  const [mappedRow] = await attachAgentRolesToToolExecutions([mapToolExecutionRow(row)]);
  return mappedRow ?? null;
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
  const rawToolExecutions = await attachAgentRolesToToolExecutions(
    toolRows.map(mapToolExecutionRow),
  );
  const rawApprovals = approvalRows.map(mapApprovalRow);
  const usage = await buildConversationUsageSummary(conversationId, mappedMessages);

  return {
    messages: mappedMessages,
    toolExecutions: rawToolExecutions.map(toToolTimelineRecord),
    pendingApprovals: rawApprovals.map(toApprovalSummaryRecord),
    usage,
  };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const conversationRows = db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
    .all();
  const messageRows = db
    .select()
    .from(messages)
    .orderBy(asc(messages.createdAt))
    .all();
  const toolRows = db
    .select()
    .from(toolExecutions)
    .orderBy(asc(toolExecutions.createdAt))
    .all();
  const approvalRows = db
    .select()
    .from(approvalRequests)
    .orderBy(asc(approvalRequests.createdAt))
    .all();

  const conversationMap = new Map<string, ReturnType<typeof createConversationSummarySeed>>();

  for (const row of conversationRows) {
    conversationMap.set(row.id, createConversationSummarySeed(row));
  }

  const getConversation = (conversationId: string) => {
    let conversation = conversationMap.get(conversationId);
    if (!conversation) {
      conversation = createConversationSummarySeed();
      conversation.id = conversationId;
      conversationMap.set(conversationId, conversation);
    }

    return conversation;
  };

  for (const row of messageRows) {
    const conversation = getConversation(row.conversationId);
    conversation.messageCount += 1;
    touchConversationActivity(conversation, row.createdAt);

    const truncatedContent = truncateInlineText(row.content, CONVERSATION_PREVIEW_MAX_LENGTH);
    if (truncatedContent) {
      conversation.preview = truncatedContent;
    }

    const titleCandidate = truncateInlineText(row.content, CONVERSATION_TITLE_MAX_LENGTH);
    if (!titleCandidate) {
      continue;
    }

    if (row.role === "user" && !conversation.titleFromUser) {
      conversation.titleSeed = titleCandidate;
      conversation.titleFromUser = true;
      continue;
    }

    if (!conversation.titleSeed) {
      conversation.titleSeed = titleCandidate;
    }
  }

  for (const row of toolRows) {
    const conversation = getConversation(row.conversationId);
    touchConversationActivity(conversation, row.createdAt);
  }

  for (const row of approvalRows) {
    const conversation = getConversation(row.conversationId);
    touchConversationActivity(conversation, row.createdAt);
    if (row.status === "pending") {
      conversation.pendingApprovalCount += 1;
    }
  }

  if (!conversationMap.has(DEFAULT_CONVERSATION_ID)) {
    const defaultConversation = createConversationSummarySeed();
    defaultConversation.id = DEFAULT_CONVERSATION_ID;
    conversationMap.set(DEFAULT_CONVERSATION_ID, defaultConversation);
  }

  return [...conversationMap.values()]
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.titleSeed ?? getConversationFallbackTitle(conversation.id),
      preview: conversation.preview,
      createdAt: conversation.createdAt,
      lastActivityAt: conversation.lastActivityAt,
      messageCount: conversation.messageCount,
      pendingApprovalCount: conversation.pendingApprovalCount,
    }))
    .sort((left, right) => {
      const leftTimestamp = left.lastActivityAt ?? left.createdAt ?? "";
      const rightTimestamp = right.lastActivityAt ?? right.createdAt ?? "";

      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp.localeCompare(leftTimestamp);
      }

      return left.title.localeCompare(right.title);
    });
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

export async function setPreference(key: string, value: string) {
  db.insert(preferences)
    .values({
      key,
      value,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: preferences.key,
      set: {
        value,
        updatedAt: nowIso(),
      },
    })
    .run();
}

export async function getApprovalPreference(key: ApprovalPreferenceKey) {
  const value = await getPreference(key);

  if (value === null) {
    return null;
  }

  return value === "true";
}

export async function getApprovalPreferences(): Promise<ApprovalPreferences> {
  const rows = db
    .select()
    .from(preferences)
    .all();
  const snapshot = createDefaultApprovalPreferences();

  for (const row of rows) {
    if (!isApprovalPreferenceKey(row.key)) {
      continue;
    }

    snapshot[row.key] = row.value === "true";
  }

  return snapshot;
}

export async function updateApprovalPreferences(
  updates: Partial<ApprovalPreferences>,
): Promise<ApprovalPreferences> {
  const entries = Object.entries(updates) as [ApprovalPreferenceKey, boolean][];

  for (const [key, value] of entries) {
    await setPreference(key, value ? "true" : "false");
  }

  return getApprovalPreferences();
}
