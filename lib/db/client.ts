import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { deriveConversationTitle, NEW_CHAT_TITLE } from "@/lib/agent/conversations";
import * as schema from "@/lib/db/schema";

export let PROJECT_ROOT = path.resolve(process.cwd());
export let AGENT_FS_ROOT = path.resolve(PROJECT_ROOT, process.env.AGENT_FS_ROOT ?? ".");
export let WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "data/workspace");
export let dbPath = path.resolve(process.cwd(), process.env.AGENT_DB_PATH ?? "./data/agent.db");

declare global {
  var __hunterClawSqlite__: Database.Database | undefined;
  var __hunterClawDb__: ReturnType<typeof createDb> | undefined;
}

function createDb(client: Database.Database) {
  return drizzle(client, { schema });
}

function resolveClientPaths({
  nextDbPath,
  nextFsRoot,
}: {
  nextDbPath?: string;
  nextFsRoot?: string;
} = {}) {
  PROJECT_ROOT = path.resolve(process.cwd());
  dbPath = path.resolve(PROJECT_ROOT, nextDbPath ?? process.env.AGENT_DB_PATH ?? "./data/agent.db");
  AGENT_FS_ROOT = path.resolve(PROJECT_ROOT, nextFsRoot ?? process.env.AGENT_FS_ROOT ?? ".");
  WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "data/workspace");
}

function ensurePaths() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(AGENT_FS_ROOT, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

function hasColumn(client: Database.Database, tableName: string, columnName: string) {
  const rows = client.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function hasTable(client: Database.Database, tableName: string) {
  const row = client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name: string } | undefined;

  return Boolean(row);
}

function ensureConversationTable(client: Database.Database) {
  client.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS conversations_updated_idx
      ON conversations (updated_at);
  `);
}

function backfillConversations(client: Database.Database) {
  ensureConversationTable(client);

  const sourceTables = [
    "messages",
    "summaries",
    "tool_executions",
    "llm_usage_events",
    "approval_requests",
  ].filter((tableName) => hasTable(client, tableName));

  if (sourceTables.length === 0) {
    return;
  }

  const rows = client
    .prepare(
      [
        "SELECT id, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at",
        "FROM (",
        sourceTables
          .map(
            (tableName) =>
              `SELECT conversation_id AS id, created_at, created_at AS updated_at FROM ${tableName}`,
          )
          .join(" UNION ALL "),
        ")",
        "GROUP BY id",
      ].join(" "),
    )
    .all() as Array<{
    id: string;
    created_at: string | null;
    updated_at: string | null;
  }>;

  const firstUserMessageStatement = hasTable(client, "messages")
    ? client.prepare(
        [
          "SELECT content",
          "FROM messages",
          "WHERE conversation_id = ? AND role = 'user'",
          "ORDER BY created_at ASC",
          "LIMIT 1",
        ].join(" "),
      )
    : null;
  const insertConversation = client.prepare(
    [
      "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at)",
      "VALUES (@id, @title, @createdAt, @updatedAt)",
    ].join(" "),
  );

  for (const row of rows) {
    if (!row.id) {
      continue;
    }

    const firstUserMessage = firstUserMessageStatement
      ? (firstUserMessageStatement.get(row.id) as { content: string } | undefined)
      : null;
    const timestamp = row.created_at ?? row.updated_at ?? new Date().toISOString();

    insertConversation.run({
      id: row.id,
      title: firstUserMessage ? deriveConversationTitle(firstUserMessage.content) : NEW_CHAT_TITLE,
      createdAt: row.created_at ?? timestamp,
      updatedAt: row.updated_at ?? timestamp,
    });
  }
}

function ensureSchema(client: Database.Database) {
  client.exec(`
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
  `);

  ensureConversationTable(client);

  if (hasTable(client, "approval_requests") && !hasColumn(client, "approval_requests", "source_message_id")) {
    client.exec(`
      ALTER TABLE approval_requests
      ADD COLUMN source_message_id TEXT;
    `);
  }

  if (hasTable(client, "tool_executions") && !hasColumn(client, "tool_executions", "presentation_json")) {
    client.exec(`
      ALTER TABLE tool_executions
      ADD COLUMN presentation_json TEXT;
    `);
  }

  if (hasTable(client, "tool_executions") && !hasColumn(client, "tool_executions", "source_message_id")) {
    client.exec(`
      ALTER TABLE tool_executions
      ADD COLUMN source_message_id TEXT;
    `);
  }

  if (hasTable(client, "tool_executions") && !hasColumn(client, "tool_executions", "retryable")) {
    client.exec(`
      ALTER TABLE tool_executions
      ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
    `);
  }

  if (hasTable(client, "tool_executions") && !hasColumn(client, "tool_executions", "retry_of_execution_id")) {
    client.exec(`
      ALTER TABLE tool_executions
      ADD COLUMN retry_of_execution_id TEXT;
    `);
  }

  if (hasTable(client, "approval_requests") && !hasColumn(client, "approval_requests", "presentation_json")) {
    client.exec(`
      ALTER TABLE approval_requests
      ADD COLUMN presentation_json TEXT;
    `);
  }

  backfillConversations(client);
}

let sqlite: Database.Database | undefined = globalThis.__hunterClawSqlite__;
export let db = globalThis.__hunterClawDb__ as ReturnType<typeof createDb>;

function initializeClient({
  nextDbPath,
  nextFsRoot,
  forceNew = false,
}: {
  nextDbPath?: string;
  nextFsRoot?: string;
  forceNew?: boolean;
} = {}) {
  resolveClientPaths({
    nextDbPath,
    nextFsRoot,
  });
  ensurePaths();

  if (forceNew && sqlite) {
    sqlite.close();
    sqlite = undefined;
    db = undefined as unknown as ReturnType<typeof createDb>;
    globalThis.__hunterClawSqlite__ = undefined;
    globalThis.__hunterClawDb__ = undefined;
  }

  sqlite = sqlite ?? new Database(dbPath);
  ensureSchema(sqlite);
  db = db ?? createDb(sqlite);

  if (process.env.NODE_ENV !== "production") {
    globalThis.__hunterClawSqlite__ = sqlite;
    globalThis.__hunterClawDb__ = db;
  }
}

initializeClient();

export function reinitializeDbClientForTests({
  nextDbPath,
  nextFsRoot,
}: {
  nextDbPath: string;
  nextFsRoot?: string;
}) {
  initializeClient({
    nextDbPath,
    nextFsRoot,
    forceNew: true,
  });
}
