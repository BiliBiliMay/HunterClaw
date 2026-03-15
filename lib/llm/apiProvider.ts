import OpenAI from "openai";
import { z } from "zod";

import type {
  ChatMessage,
  ProviderDecision,
  ProviderDecisionResult,
  ToolExecutionRecord,
  ProviderContext,
  ProviderSummaryResult,
  ProviderUsage,
} from "@/lib/agent/types";
import { AGENT_FS_ROOT } from "@/lib/db/client";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";
import {
  buildApiDecisionPrompt,
  buildApiSummaryPrompt,
} from "@/lib/llm/prompts";

const decisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("tool_call"),
    toolName: z.enum(["fileTool", "shellTool", "browserTool"]),
    args: z.record(z.string(), z.any()),
    reason: z.string().min(1),
  }),
]);

const messageTypeAliases = new Set([
  "assistant",
  "assistant_message",
  "answer",
  "final",
  "message",
  "reply",
  "response",
  "text",
]);

const toolTypeAliases = new Set([
  "call_tool",
  "function",
  "function_call",
  "tool",
  "tool_call",
  "tool_use",
  "toolcall",
  "tooluse",
]);

const toolNameAliases: Record<string, "fileTool" | "shellTool" | "browserTool"> = {
  bash: "shellTool",
  browser: "browserTool",
  browsertool: "browserTool",
  command: "shellTool",
  file: "fileTool",
  filesystem: "fileTool",
  filetool: "fileTool",
  playwright: "browserTool",
  shell: "shellTool",
  shelltool: "shellTool",
  terminal: "shellTool",
  web: "browserTool",
};

function getApiClient() {
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("LLM_PROVIDER=api requires LLM_API_KEY or OPENAI_API_KEY.");
  }

  return new OpenAI({
    apiKey,
    baseURL: process.env.LLM_API_BASE_URL ?? process.env.OPENAI_BASE_URL,
  });
}

function getApiModel() {
  return process.env.LLM_API_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4";
}

function formatRecentMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
}

function formatRecentToolExecutions(toolExecutions: ToolExecutionRecord[]) {
  return toolExecutions
    .map((toolExecution) => {
      const result =
        toolExecution.error ??
        JSON.stringify(toolExecution.result ?? null);
      return [
        `TOOL: ${toolExecution.toolName}`,
        `STATUS: ${toolExecution.status}`,
        `ARGS: ${JSON.stringify(toolExecution.args)}`,
        `RESULT: ${result}`,
      ].join("\n");
    })
    .join("\n\n");
}

function extractJsonPayload(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("API provider returned an empty response.");
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]+?)```/i.exec(trimmed);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");

  const hasObjectPayload = objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart;
  const hasArrayPayload = arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart;

  if (hasArrayPayload && (!hasObjectPayload || arrayStart < objectStart)) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  if (!hasObjectPayload) {
    throw new Error(`API provider did not return JSON. Raw response: ${trimmed.slice(0, 300)}`);
  }

  return trimmed.slice(objectStart, objectEnd + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeType(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => Boolean(item));

    if (parts.length === 0) {
      return null;
    }

    return parts.join("\n\n");
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["text", "content", "message", "response", "answer"]) {
    if (key in value) {
      const extracted = extractText(value[key], depth + 1);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function normalizeToolName(value: unknown): "fileTool" | "shellTool" | "browserTool" | null {
  if (typeof value !== "string") {
    return null;
  }

  const directMatch = decisionSchema.options[1].shape.toolName.safeParse(value);
  if (directMatch.success) {
    return directMatch.data;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return toolNameAliases[normalized] ?? null;
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      return { value: trimmed };
    }
  }

  return {};
}

function normalizeDecision(value: unknown, depth = 0): ProviderDecision | null {
  if (depth > 6 || value == null) {
    return null;
  }

  const directParse = decisionSchema.safeParse(value);
  if (directParse.success) {
    return directParse.data;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return normalizeDecision(JSON.parse(trimmed), depth + 1);
      } catch {
        return {
          type: "message",
          content: trimmed,
        };
      }
    }

    return {
      type: "message",
      content: trimmed,
    };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeDecision(item, depth + 1);
      if (normalized?.type === "tool_call") {
        return normalized;
      }
    }

    const textContent = extractText(value, depth + 1);
    return textContent
      ? {
          type: "message",
          content: textContent,
        }
      : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const nestedKey of ["decision", "response", "result", "output", "payload", "data"]) {
    if (!(nestedKey in value)) {
      continue;
    }

    const nestedDecision = normalizeDecision(value[nestedKey], depth + 1);
    if (nestedDecision) {
      return nestedDecision;
    }
  }

  if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) {
    const toolCall = normalizeDecision(value.tool_calls[0], depth + 1);
    if (toolCall) {
      return toolCall;
    }
  }

  if (isRecord(value.function_call)) {
    const functionToolName = normalizeToolName(value.function_call.name);
    if (functionToolName) {
      return {
        type: "tool_call",
        toolName: functionToolName,
        args: normalizeArgs(value.function_call.arguments),
        reason: extractText(value.reason) ?? "Tool needed to continue.",
      };
    }
  }

  const normalizedType = normalizeType(value.type);
  if (normalizedType && messageTypeAliases.has(normalizedType)) {
    const content = extractText(
      value.content ?? value.message ?? value.text ?? value.response ?? value.answer,
      depth + 1,
    );
    if (content) {
      return {
        type: "message",
        content,
      };
    }
  }

  const explicitToolName = normalizeToolName(
    value.toolName ??
      value.tool ??
      value.name ??
      (isRecord(value.function) ? value.function.name : undefined),
  );
  if (explicitToolName && (!normalizedType || toolTypeAliases.has(normalizedType))) {
    return {
      type: "tool_call",
      toolName: explicitToolName,
      args: normalizeArgs(
        value.args ??
          value.arguments ??
          value.input ??
          value.parameters ??
          (isRecord(value.function) ? value.function.arguments : undefined),
      ),
      reason: extractText(value.reason) ?? "Tool needed to continue.",
    };
  }

  const content = extractText(
    value.content ?? value.message ?? value.text ?? value.response ?? value.answer,
    depth + 1,
  );
  if (content) {
    return {
      type: "message",
      content,
    };
  }

  return null;
}

function parseDecisionResponse(rawText: string) {
  if (!rawText.trim()) {
    throw new Error("The model returned an empty response.");
  }

  try {
    const parsedPayload = JSON.parse(extractJsonPayload(rawText));
    const normalized = normalizeDecision(parsedPayload);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall back to normalization from plain text below.
  }

  const normalized = normalizeDecision(rawText);
  if (normalized) {
    return normalized;
  }

  console.warn("API provider returned an unparseable planning response:", rawText.slice(0, 600));
  throw new Error("The model returned a response that HunterClaw could not interpret as a message or tool call.");
}

function buildUsage(
  operation: ProviderUsage["operation"],
  modelName: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } | null | undefined,
): ProviderUsage {
  return {
    providerName: "api",
    modelName,
    operation,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

async function createTextResponse(input: string, operation: ProviderUsage["operation"]) {
  const client = getApiClient();
  const modelName = getApiModel();
  const response = await client.responses.create({
    model: modelName,
    input,
  });

  return {
    text: response.output_text?.trim() ?? "",
    usage: buildUsage(operation, modelName, response.usage),
  };
}

export const apiProvider: AgentProvider = {
  name: "api",
  async generateResponse(context: ProviderContext): Promise<ProviderDecisionResult> {
    const response = await createTextResponse(
      buildApiDecisionPrompt({
        modelName: getApiModel(),
        workspaceRoot: AGENT_FS_ROOT,
        summary: context.summary,
        latestUserMessage: context.latestUserMessage,
        recentMessages: formatRecentMessages(context.recentMessages),
        recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
        lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
        stepIndex: context.stepIndex,
      }),
      "decision",
    );

    return {
      decision: parseDecisionResponse(response.text),
      usage: response.usage,
    };
  },
  async plan(context: ProviderContext) {
    return apiProvider.generateResponse(context);
  },
  async summarize(context: SummaryContext): Promise<ProviderSummaryResult> {
    const response = await createTextResponse(
      buildApiSummaryPrompt({
        previousSummary: context.previousSummary,
        transcript: formatRecentMessages(context.messages),
      }),
      "summary",
    );

    return {
      summary: response.text.trim(),
      usage: response.usage,
    };
  },
};
