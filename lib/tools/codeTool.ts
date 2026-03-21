import fs from "node:fs/promises";
import path from "node:path";

import {
  applyPatch as applyUnifiedPatch,
  createTwoFilesPatch,
  parsePatch,
} from "diff";
import type { StructuredPatch } from "diff";
import { z } from "zod";

import type {
  CodePresentationStats,
  JsonValue,
  RiskLevel,
  ToolPresentationDetails,
} from "@/lib/agent/types";
import type { FileAccessScope } from "@/lib/tools/fileTool";
import { resolveFilePath } from "@/lib/tools/fileTool";
import { stripWrappingQuotes } from "@/lib/utils";

const MAX_PREVIEW_LINES = 200;
const MAX_PREVIEW_BYTES = 24_000;

const languageByExtension: Record<string, string> = {
  ".cjs": "javascript",
  ".css": "css",
  ".go": "go",
  ".html": "markup",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "bash",
  ".sql": "sql",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "text",
  ".xml": "markup",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export const codeToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("createFile"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    action: z.literal("applyPatch"),
    patch: z.string().min(1),
  }),
]);

export type CodeToolArgs = z.infer<typeof codeToolSchema>;

export type PreparedCodeOperation = {
  action: CodeToolArgs["action"];
  path: string;
  resolvedPath: string;
  scope: FileAccessScope;
  beforeContent: string | null;
  afterContent: string;
  patch: string;
  bytesWritten: number;
  stats: CodePresentationStats;
  presentation: ToolPresentationDetails;
};

function trimPatchPath(value: string | undefined) {
  if (!value) {
    return null;
  }

  const normalized = stripWrappingQuotes(value.trim());
  if (!normalized) {
    return null;
  }

  if (normalized === "/dev/null") {
    return normalized;
  }

  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return normalized.slice(2);
  }

  return normalized;
}

function getCodeLanguage(filePath: string) {
  return languageByExtension[path.extname(filePath).toLowerCase()] ?? "text";
}

function truncatePreview(value: string | null) {
  if (value == null) {
    return {
      content: null,
      truncated: false,
    };
  }

  const lines = value.split("\n");
  let nextLines = lines.slice(0, MAX_PREVIEW_LINES);
  let content = nextLines.join("\n");
  let truncated = nextLines.length < lines.length;

  while (Buffer.byteLength(content, "utf8") > MAX_PREVIEW_BYTES && nextLines.length > 0) {
    nextLines = nextLines.slice(0, -1);
    content = nextLines.join("\n");
    truncated = true;
  }

  return {
    content,
    truncated,
  };
}

function collectPatchStats(patch: string): CodePresentationStats {
  const parsedPatch = parsePatch(patch);
  const hunks = parsedPatch[0]?.hunks ?? [];

  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions += 1;
      }
    }
  }

  return {
    additions,
    deletions,
    bytesBefore: 0,
    bytesAfter: 0,
  };
}

function buildPresentationDetails({
  action,
  targetPath,
  beforeContent,
  afterContent,
  patch,
}: {
  action: CodeToolArgs["action"];
  targetPath: string;
  beforeContent: string | null;
  afterContent: string;
  patch: string;
}): ToolPresentationDetails {
  const beforeSnippet = truncatePreview(beforeContent);
  const afterSnippet = truncatePreview(afterContent);
  const patchSnippet = truncatePreview(patch);
  const stats = collectPatchStats(patch);

  stats.bytesBefore = Buffer.byteLength(beforeContent ?? "", "utf8");
  stats.bytesAfter = Buffer.byteLength(afterContent, "utf8");

  return {
    action,
    path: targetPath,
    language: getCodeLanguage(targetPath),
    stats,
    patch: patchSnippet.content,
    beforeSnippet: beforeSnippet.content,
    afterSnippet: afterSnippet.content,
    truncated: beforeSnippet.truncated || afterSnippet.truncated || patchSnippet.truncated,
  };
}

function normalizePatchEntry(patch: StructuredPatch) {
  const oldPath = trimPatchPath(patch.oldFileName);
  const newPath = trimPatchPath(patch.newFileName);

  if (!oldPath || !newPath) {
    throw new Error("Patch must include both old and new file paths.");
  }

  if (oldPath === "/dev/null" || newPath === "/dev/null") {
    throw new Error("Patch file creation and deletion are not supported. Use createFile for new files.");
  }

  if (oldPath !== newPath) {
    throw new Error("Patch rename operations are not supported.");
  }

  return oldPath;
}

function validatePatchText(patch: string) {
  if (patch.includes("GIT binary patch") || patch.includes("Binary files")) {
    throw new Error("Binary patches are not supported.");
  }

  const parsedPatch = parsePatch(patch);
  if (parsedPatch.length !== 1) {
    throw new Error("Patch must target exactly one file.");
  }

  const [patchEntry] = parsedPatch;
  if (!patchEntry || patchEntry.hunks.length === 0) {
    throw new Error("Patch must contain at least one hunk.");
  }

  const targetPath = normalizePatchEntry(patchEntry);

  return {
    parsedPatch,
    targetPath,
  };
}

function createNormalizedPatch(targetPath: string, beforeContent: string | null, afterContent: string) {
  return createTwoFilesPatch(
    targetPath,
    targetPath,
    beforeContent ?? "",
    afterContent,
    "",
    "",
    {
      context: 3,
    },
  );
}

async function readExistingTextFile(resolvedPath: string) {
  return fs.readFile(resolvedPath, "utf8");
}

export function getCodeToolRiskLevel(args: CodeToolArgs): RiskLevel {
  if (args.action === "createFile") {
    return resolveFilePath(args.path).scope === "project" ? "medium" : "high";
  }

  const { targetPath } = validatePatchText(args.patch);
  return resolveFilePath(targetPath).scope === "project" ? "medium" : "high";
}

export async function prepareCodeToolOperation(args: CodeToolArgs): Promise<PreparedCodeOperation> {
  if (args.action === "createFile") {
    const target = resolveFilePath(args.path);

    try {
      await fs.access(target.resolvedPath);
      throw new Error(`File already exists: ${target.requestedPath}`);
    } catch (error) {
      if (!(error instanceof Error) || "code" in error === false || error.code !== "ENOENT") {
        if (error instanceof Error && error.message.startsWith("File already exists:")) {
          throw error;
        }

        throw error;
      }
    }

    const patch = createNormalizedPatch(target.requestedPath, null, args.content);

    return {
      action: args.action,
      path: target.requestedPath,
      resolvedPath: target.resolvedPath,
      scope: target.scope,
      beforeContent: null,
      afterContent: args.content,
      patch,
      bytesWritten: Buffer.byteLength(args.content, "utf8"),
      stats: collectPatchStats(patch),
      presentation: buildPresentationDetails({
        action: args.action,
        targetPath: target.requestedPath,
        beforeContent: null,
        afterContent: args.content,
        patch,
      }),
    };
  }

  const { parsedPatch, targetPath } = validatePatchText(args.patch);
  const target = resolveFilePath(targetPath);
  const beforeContent = await readExistingTextFile(target.resolvedPath);
  const afterContent = applyUnifiedPatch(beforeContent, parsedPatch[0]);

  if (afterContent === false) {
    throw new Error(`Patch could not be applied cleanly to ${target.requestedPath}.`);
  }

  const normalizedPatch = createNormalizedPatch(target.requestedPath, beforeContent, afterContent);

  return {
    action: args.action,
    path: target.requestedPath,
    resolvedPath: target.resolvedPath,
    scope: target.scope,
    beforeContent,
    afterContent,
    patch: normalizedPatch,
    bytesWritten: Buffer.byteLength(afterContent, "utf8"),
    stats: collectPatchStats(normalizedPatch),
    presentation: buildPresentationDetails({
      action: args.action,
      targetPath: target.requestedPath,
      beforeContent,
      afterContent,
      patch: normalizedPatch,
    }),
  };
}

export const codeTool = {
  name: "codeTool",
  description: "Create new files and edit existing files through validated single-file patches.",
  schema: codeToolSchema,
  getRiskLevel(args: CodeToolArgs): RiskLevel {
    return getCodeToolRiskLevel(args);
  },
  async execute(args: CodeToolArgs): Promise<JsonValue> {
    const prepared = await prepareCodeToolOperation(args);

    await fs.mkdir(path.dirname(prepared.resolvedPath), { recursive: true });
    await fs.writeFile(prepared.resolvedPath, prepared.afterContent, "utf8");

    return {
      action: prepared.action,
      path: prepared.path,
      resolvedPath: prepared.resolvedPath,
      scope: prepared.scope,
      bytesWritten: prepared.bytesWritten,
      additions: prepared.stats.additions,
      deletions: prepared.stats.deletions,
    };
  },
};
