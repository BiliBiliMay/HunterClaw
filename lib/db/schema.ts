import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    updatedIdx: index("conversations_updated_idx").on(table.updatedAt),
  }),
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    metaJson: text("meta_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    conversationCreatedIdx: index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const summaries = sqliteTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    content: text("content").notNull(),
    lastMessageId: text("last_message_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    conversationCreatedIdx: index("summaries_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const toolExecutions = sqliteTable(
  "tool_executions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    toolName: text("tool_name").notNull(),
    argsJson: text("args_json").notNull(),
    presentationJson: text("presentation_json"),
    riskLevel: text("risk_level").notNull(),
    status: text("status").notNull(),
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => ({
    conversationCreatedIdx: index("tool_executions_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const llmUsageEvents = sqliteTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sourceMessageId: text("source_message_id"),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    operation: text("operation").notNull(),
    inputTokens: text("input_tokens"),
    outputTokens: text("output_tokens"),
    totalTokens: text("total_tokens"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    conversationCreatedIdx: index("llm_usage_events_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    sourceMessageIdx: index("llm_usage_events_source_message_idx").on(table.sourceMessageId),
  }),
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sourceMessageId: text("source_message_id"),
    toolName: text("tool_name").notNull(),
    argsJson: text("args_json").notNull(),
    presentationJson: text("presentation_json"),
    riskLevel: text("risk_level").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => ({
    conversationCreatedIdx: index("approval_requests_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    statusIdx: index("approval_requests_status_idx").on(table.status),
  }),
);
