import OpenAI from "openai";

import type {
  ChatMessage,
  ProviderDecisionResult,
  ProviderContext,
  ProviderResponseResult,
  ProviderSummaryResult,
  ProviderUsage,
  ToolExecutionRecord,
} from "@/lib/agent/types";
import { AGENT_FS_ROOT } from "@/lib/db/client";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";
import { parseDecisionResponse } from "@/lib/llm/decisionParser";
import {
  buildApiDecisionPrompt,
  buildApiResponsePrompt,
  buildApiSummaryPrompt,
} from "@/lib/llm/prompts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolArgs(toolExecution: ToolExecutionRecord) {
  if (toolExecution.toolName !== "codeTool" || !isRecord(toolExecution.args)) {
    return JSON.stringify(toolExecution.args);
  }

  const action = typeof toolExecution.args.action === "string" ? toolExecution.args.action : null;
  if (action === "createFile") {
    return JSON.stringify({
      action,
      path: typeof toolExecution.args.path === "string" ? toolExecution.args.path : null,
      contentBytes:
        typeof toolExecution.args.content === "string"
          ? Buffer.byteLength(toolExecution.args.content, "utf8")
          : null,
    });
  }

  if (action === "applyPatch") {
    return JSON.stringify({
      action,
      path: toolExecution.presentation?.path ?? null,
      patchBytes:
        typeof toolExecution.args.patch === "string"
          ? Buffer.byteLength(toolExecution.args.patch, "utf8")
          : null,
    });
  }

  return JSON.stringify(toolExecution.args);
}

export function formatRecentToolExecutions(toolExecutions: ToolExecutionRecord[]) {
  return toolExecutions
    .map((toolExecution) => {
      const result =
        toolExecution.error ??
        JSON.stringify(toolExecution.result ?? null);
      return [
        `TOOL: ${toolExecution.toolName}`,
        `STATUS: ${toolExecution.status}`,
        `ARGS: ${formatToolArgs(toolExecution)}`,
        `RESULT: ${result}`,
      ].join("\n");
    })
    .join("\n\n");
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
    text: response.output_text ?? "",
    usage: buildUsage(operation, modelName, response.usage),
  };
}

async function createStreamingTextResponse(
  input: string,
  operation: ProviderUsage["operation"],
  onDelta: (delta: string) => void | Promise<void>,
): Promise<ProviderResponseResult> {
  const client = getApiClient();
  const modelName = getApiModel();
  const stream = await client.responses.create({
    model: modelName,
    input,
    stream: true,
  });

  let streamedText = "";
  let usage = buildUsage(operation, modelName, null);

  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && event.delta) {
      streamedText += event.delta;
      await onDelta(event.delta);
    }

    if (event.type === "response.completed") {
      return {
        content: event.response.output_text ?? streamedText,
        usage: buildUsage(operation, modelName, event.response.usage),
      };
    }
  }

  return {
    content: streamedText,
    usage,
  };
}

export const apiProvider: AgentProvider = {
  name: "api",
  async plan(context: ProviderContext): Promise<ProviderDecisionResult> {
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
  async respond(context: ProviderContext): Promise<ProviderResponseResult> {
    const response = await createTextResponse(
      buildApiResponsePrompt({
        modelName: getApiModel(),
        workspaceRoot: AGENT_FS_ROOT,
        summary: context.summary,
        latestUserMessage: context.latestUserMessage,
        recentMessages: formatRecentMessages(context.recentMessages),
        recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
        lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
      }),
      "response",
    );

    return {
      content: response.text,
      usage: response.usage,
    };
  },
  async streamResponse(context: ProviderContext, onDelta) {
    return createStreamingTextResponse(
      buildApiResponsePrompt({
        modelName: getApiModel(),
        workspaceRoot: AGENT_FS_ROOT,
        summary: context.summary,
        latestUserMessage: context.latestUserMessage,
        recentMessages: formatRecentMessages(context.recentMessages),
        recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
        lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
      }),
      "response",
      onDelta,
    );
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
