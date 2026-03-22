import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { deriveConversationTitle, NEW_CHAT_TITLE } from "@/lib/agent/conversations";

const dbPath = path.resolve(process.cwd(), process.env.AGENT_DB_PATH ?? "./data/agent.db");
const workspaceRoot = path.resolve(process.cwd(), "data/workspace");
const welcomeFilePath = path.join(workspaceRoot, "welcome.txt");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

const sqlite = new Database(dbPath);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS conversations_updated_idx
    ON conversations (updated_at);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    meta_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
    ON messages (conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS summaries_conversation_created_idx
    ON summaries (conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tool_executions (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    agent_run_id TEXT,
    source_message_id TEXT,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    presentation_json TEXT,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    retryable INTEGER NOT NULL DEFAULT 0,
    retry_of_execution_id TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS tool_executions_conversation_created_idx
    ON tool_executions (conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS llm_usage_events (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    source_message_id TEXT,
    provider_name TEXT NOT NULL,
    model_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    input_tokens TEXT,
    output_tokens TEXT,
    total_tokens TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS llm_usage_events_conversation_created_idx
    ON llm_usage_events (conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS llm_usage_events_source_message_idx
    ON llm_usage_events (source_message_id);

  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    agent_run_id TEXT,
    source_message_id TEXT,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    presentation_json TEXT,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS approval_requests_conversation_created_idx
    ON approval_requests (conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS approval_requests_status_idx
    ON approval_requests (status);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    parent_run_id TEXT,
    source_message_id TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT,
    result_json TEXT,
    last_tool_execution_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_runs_conversation_created_idx
    ON agent_runs (conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS agent_runs_parent_created_idx
    ON agent_runs (parent_run_id, created_at);

  CREATE INDEX IF NOT EXISTS agent_runs_source_message_created_idx
    ON agent_runs (source_message_id, created_at);
`);

const conversationRows = sqlite
  .prepare(
    [
      "SELECT id, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at",
      "FROM (",
      "  SELECT conversation_id AS id, created_at, created_at AS updated_at FROM messages",
      "  UNION ALL",
      "  SELECT conversation_id AS id, created_at, created_at AS updated_at FROM summaries",
      "  UNION ALL",
      "  SELECT conversation_id AS id, created_at, created_at AS updated_at FROM tool_executions",
      "  UNION ALL",
      "  SELECT conversation_id AS id, created_at, created_at AS updated_at FROM llm_usage_events",
      "  UNION ALL",
      "  SELECT conversation_id AS id, created_at, created_at AS updated_at FROM approval_requests",
      ")",
      "GROUP BY id",
    ].join(" "),
  )
  .all() as Array<{
  id: string;
  created_at: string | null;
  updated_at: string | null;
}>;

const firstUserMessageStatement = sqlite.prepare(
  [
    "SELECT content",
    "FROM messages",
    "WHERE conversation_id = ? AND role = 'user'",
    "ORDER BY created_at ASC",
    "LIMIT 1",
  ].join(" "),
);
const insertConversation = sqlite.prepare(
  [
    "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)",
    "VALUES (@id, @title, @createdAt, @updatedAt)",
  ].join(" "),
);

for (const row of conversationRows) {
  if (!row.id) {
    continue;
  }

  const firstUserMessage = firstUserMessageStatement.get(row.id) as { content: string } | undefined;
  const timestamp = row.created_at ?? row.updated_at ?? new Date().toISOString();

  insertConversation.run({
    id: row.id,
    title: firstUserMessage ? deriveConversationTitle(firstUserMessage.content) : NEW_CHAT_TITLE,
    createdAt: row.created_at ?? timestamp,
    updatedAt: row.updated_at ?? timestamp,
  });
}

const approvalColumns = sqlite
  .prepare("PRAGMA table_info(approval_requests)")
  .all() as Array<{ name: string }>;

if (!approvalColumns.some((column) => column.name === "source_message_id")) {
  sqlite.exec(`
    ALTER TABLE approval_requests
    ADD COLUMN source_message_id TEXT;
  `);
}

const toolExecutionColumns = sqlite
  .prepare("PRAGMA table_info(tool_executions)")
  .all() as Array<{ name: string }>;

if (!toolExecutionColumns.some((column) => column.name === "presentation_json")) {
  sqlite.exec(`
    ALTER TABLE tool_executions
    ADD COLUMN presentation_json TEXT;
  `);
}

if (!toolExecutionColumns.some((column) => column.name === "source_message_id")) {
  sqlite.exec(`
    ALTER TABLE tool_executions
    ADD COLUMN source_message_id TEXT;
  `);
}

if (!toolExecutionColumns.some((column) => column.name === "agent_run_id")) {
  sqlite.exec(`
    ALTER TABLE tool_executions
    ADD COLUMN agent_run_id TEXT;
  `);
}

if (!toolExecutionColumns.some((column) => column.name === "retryable")) {
  sqlite.exec(`
    ALTER TABLE tool_executions
    ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
  `);
}

if (!toolExecutionColumns.some((column) => column.name === "retry_of_execution_id")) {
  sqlite.exec(`
    ALTER TABLE tool_executions
    ADD COLUMN retry_of_execution_id TEXT;
  `);
}

if (!approvalColumns.some((column) => column.name === "presentation_json")) {
  sqlite.exec(`
    ALTER TABLE approval_requests
    ADD COLUMN presentation_json TEXT;
  `);
}

if (!approvalColumns.some((column) => column.name === "agent_run_id")) {
  sqlite.exec(`
    ALTER TABLE approval_requests
    ADD COLUMN agent_run_id TEXT;
  `);
}

sqlite.exec(`
  CREATE INDEX IF NOT EXISTS tool_executions_agent_run_created_idx
    ON tool_executions (agent_run_id, created_at);

  CREATE INDEX IF NOT EXISTS approval_requests_agent_run_created_idx
    ON approval_requests (agent_run_id, created_at);
`);

if (!fs.existsSync(welcomeFilePath)) {
  fs.writeFileSync(
    welcomeFilePath,
    [
      "Welcome to HunterClaw.",
      "",
      "This is the local workspace that the MVP agent can read, list, and write inside.",
      "Try asking:",
      "- list files",
      "- read file welcome.txt",
      "- write file notes.txt with content hello from HunterClaw",
    ].join("\n"),
    "utf8",
  );
}

console.log(`Database ready at ${dbPath}`);
console.log(`Workspace ready at ${workspaceRoot}`);
