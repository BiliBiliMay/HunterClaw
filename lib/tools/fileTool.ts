import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";
import { WORKSPACE_ROOT } from "@/lib/db/client";
import { stripWrappingQuotes } from "@/lib/utils";

const MAX_TEXT_BYTES = 64_000;

export const fileToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("readFile"),
    path: z.string().min(1),
  }),
  z.object({
    action: z.literal("writeFile"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    action: z.literal("listDirectory"),
    path: z.string().min(1).default("."),
  }),
]);

export type FileToolArgs = z.infer<typeof fileToolSchema>;

export function resolveWorkspacePath(inputPath: string) {
  const normalizedPath = stripWrappingQuotes(inputPath).trim() || ".";
  const resolvedPath = path.resolve(WORKSPACE_ROOT, normalizedPath);
  const workspaceWithSeparator = `${WORKSPACE_ROOT}${path.sep}`;

  if (resolvedPath !== WORKSPACE_ROOT && !resolvedPath.startsWith(workspaceWithSeparator)) {
    throw new Error("File access is restricted to data/workspace.");
  }

  return resolvedPath;
}

export const fileTool = {
  name: "fileTool",
  description: "Read, write, and list files inside the local workspace.",
  schema: fileToolSchema,
  getRiskLevel(args: FileToolArgs): RiskLevel {
    return args.action === "writeFile" ? "medium" : "low";
  },
  async execute(args: FileToolArgs): Promise<JsonValue> {
    if (args.action === "listDirectory") {
      const targetPath = resolveWorkspacePath(args.path);
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const sortedEntries = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        action: "listDirectory",
        path: args.path,
        entries: sortedEntries,
      };
    }

    if (args.action === "readFile") {
      const targetPath = resolveWorkspacePath(args.path);
      const fileContent = await fs.readFile(targetPath, "utf8");

      if (Buffer.byteLength(fileContent, "utf8") > MAX_TEXT_BYTES) {
        throw new Error("The file is too large for this MVP reader.");
      }

      return {
        action: "readFile",
        path: args.path,
        content: fileContent,
      };
    }

    const targetPath = resolveWorkspacePath(args.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, args.content, "utf8");

    return {
      action: "writeFile",
      path: args.path,
      bytesWritten: Buffer.byteLength(args.content, "utf8"),
    };
  },
};

