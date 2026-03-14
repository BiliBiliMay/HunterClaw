import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "@/lib/db/schema";

const dbPath = path.resolve(process.cwd(), process.env.AGENT_DB_PATH ?? "./data/agent.db");
export const WORKSPACE_ROOT = path.resolve(process.cwd(), "data/workspace");

function ensurePaths() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

const sqlite = globalThis.__hunterClawSqlite__ ?? new Database(dbPath);
const db = globalThis.__hunterClawDb__ ?? createDb(sqlite);

if (process.env.NODE_ENV !== "production") {
  globalThis.__hunterClawSqlite__ = sqlite;
  globalThis.__hunterClawDb__ = db;
}

export { db, dbPath };
