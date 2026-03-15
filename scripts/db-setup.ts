import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const dbPath = path.resolve(process.cwd(), process.env.AGENT_DB_PATH ?? "./data/agent.db");
const workspaceRoot = path.resolve(process.cwd(), "data/workspace");
const welcomeFilePath = path.join(workspaceRoot, "welcome.txt");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

const sqlite = new Database(dbPath);

sqlite.exec(`
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
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
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
    source_message_id TEXT,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
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
`);

const approvalColumns = sqlite
  .prepare("PRAGMA table_info(approval_requests)")
  .all() as Array<{ name: string }>;

if (!approvalColumns.some((column) => column.name === "source_message_id")) {
  sqlite.exec(`
    ALTER TABLE approval_requests
    ADD COLUMN source_message_id TEXT;
  `);
}

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
