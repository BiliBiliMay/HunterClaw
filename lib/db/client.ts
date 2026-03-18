import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { deriveConversationTitle, NEW_CHAT_TITLE } from "@/lib/agent/conversations";
import * as schema from "@/lib/db/schema";

export const PROJECT_ROOT = path.resolve(process.cwd());
const dbPath = path.resolve(process.cwd(), process.env.AGENT_DB_PATH ?? "./data/agent.db");
export const AGENT_FS_ROOT = path.resolve(PROJECT_ROOT, process.env.AGENT_FS_ROOT ?? ".");
export const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "data/workspace");

function ensurePaths() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(AGENT_FS_ROOT, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

ensurePaths();

declare global {
  var __hunterClawSqlite__: Database.Database | undefined;
  var __hunterClawDb__: ReturnType<typeof createDb> | undefined;
}

function createDb(client: Database.Database) {
  return drizzle(client, { schema });
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
  `);

  ensureConversationTable(client);

  if (hasTable(client, "approval_requests") && !hasColumn(client, "approval_requests", "source_message_id")) {
    client.exec(`
      ALTER TABLE approval_requests
      ADD COLUMN source_message_id TEXT;
    `);
  }

  backfillConversations(client);
}

const sqlite = globalThis.__hunterClawSqlite__ ?? new Database(dbPath);
ensureSchema(sqlite);
const db = globalThis.__hunterClawDb__ ?? createDb(sqlite);

if (process.env.NODE_ENV !== "production") {
  globalThis.__hunterClawSqlite__ = sqlite;
  globalThis.__hunterClawDb__ = db;
}

export { db, dbPath };
