import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";
import { AGENT_FS_ROOT } from "@/lib/db/client";
import { stripWrappingQuotes } from "@/lib/utils";

const MAX_TEXT_BYTES = 200_000;
export type FileAccessScope = "project" | "host";

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

function isWithinRoot(targetPath: string, rootPath: string) {
  const rootWithSeparator = `${rootPath}${path.sep}`;
  return targetPath === rootPath || targetPath.startsWith(rootWithSeparator);
}

function normalizeInputPath(inputPath: string) {
  const normalizedPath = stripWrappingQuotes(inputPath).trim() || ".";
  if (normalizedPath === "~") {
    return os.homedir();
  }

  if (normalizedPath.startsWith("~/")) {
    return path.join(os.homedir(), normalizedPath.slice(2));
  }

  return normalizedPath;
}

export function resolveFilePath(inputPath: string) {
  const normalizedPath = normalizeInputPath(inputPath);
  const resolvedPath = path.isAbsolute(normalizedPath)
    ? path.resolve(normalizedPath)
    : path.resolve(AGENT_FS_ROOT, normalizedPath);

  return {
    requestedPath: inputPath,
    resolvedPath,
    scope: isWithinRoot(resolvedPath, AGENT_FS_ROOT) ? "project" as const : "host" as const,
  };
}

export function getFileToolRiskLevel(args: FileToolArgs): RiskLevel {
  const { scope } = resolveFilePath(args.path);

  if (args.action === "writeFile") {
    return scope === "project" ? "medium" : "high";
  }

  return scope === "project" ? "low" : "medium";
}

export const fileTool = {
  name: "fileTool",
  description: "Read, write, and list local files. Access outside the project root requires approval.",
  schema: fileToolSchema,
  getRiskLevel(args: FileToolArgs): RiskLevel {
    return getFileToolRiskLevel(args);
  },
  async execute(args: FileToolArgs): Promise<JsonValue> {
    if (args.action === "listDirectory") {
      const target = resolveFilePath(args.path);
      const entries = await fs.readdir(target.resolvedPath, { withFileTypes: true });
      const sortedEntries = entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        action: "listDirectory",
        path: target.requestedPath,
        resolvedPath: target.resolvedPath,
        scope: target.scope,
        entries: sortedEntries,
      };
    }

    if (args.action === "readFile") {
      const target = resolveFilePath(args.path);
      const fileContent = await fs.readFile(target.resolvedPath, "utf8");

      if (Buffer.byteLength(fileContent, "utf8") > MAX_TEXT_BYTES) {
        throw new Error("The file is too large to return in a single read.");
      }

      return {
        action: "readFile",
        path: target.requestedPath,
        resolvedPath: target.resolvedPath,
        scope: target.scope,
        content: fileContent,
      };
    }

    const target = resolveFilePath(args.path);
    await fs.mkdir(path.dirname(target.resolvedPath), { recursive: true });
    await fs.writeFile(target.resolvedPath, args.content, "utf8");

    return {
      action: "writeFile",
      path: target.requestedPath,
      resolvedPath: target.resolvedPath,
      scope: target.scope,
      bytesWritten: Buffer.byteLength(args.content, "utf8"),
    };
  },
};
