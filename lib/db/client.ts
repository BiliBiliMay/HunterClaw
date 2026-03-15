import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

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

  if (!hasColumn(client, "approval_requests", "source_message_id")) {
    client.exec(`
      ALTER TABLE approval_requests
      ADD COLUMN source_message_id TEXT;
    `);
  }
}

const sqlite = globalThis.__hunterClawSqlite__ ?? new Database(dbPath);
ensureSchema(sqlite);
const db = globalThis.__hunterClawDb__ ?? createDb(sqlite);

if (process.env.NODE_ENV !== "production") {
  globalThis.__hunterClawSqlite__ = sqlite;
  globalThis.__hunterClawDb__ = db;
}

export { db, dbPath };
