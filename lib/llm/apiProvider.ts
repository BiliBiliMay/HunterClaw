import OpenAI from "openai";

import type {
  AgentRole,
  ChatMessage,
  ExecutorContext,
  ProviderDecisionResult,
  ProviderContext,
  ProviderResponseResult,
  ProviderSubAgentResult,
  ProviderSummaryResult,
  ProviderUsage,
  SubAgentResult,
  ToolExecutionRecord,
} from "@/lib/agent/types";
import { AGENT_FS_ROOT } from "@/lib/db/client";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";
import { parseDecisionResponse } from "@/lib/llm/decisionParser";
import {
  buildApiExecutorDecisionPrompt,
  buildApiExecutorResultPrompt,
  buildApiPlannerDecisionPrompt,
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

export function getApiModelForRole(role: AgentRole) {
  if (role === "executor") {
    return process.env.LLM_API_MODEL_EXECUTOR?.trim() || "qwen3.5-plus";
  }

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
      const result = toolExecution.error ?? JSON.stringify(toolExecution.result ?? null);
      return [
        `TOOL: ${toolExecution.toolName}`,
        `ROLE: ${toolExecution.agentRole ?? "planner"}`,
        `STATUS: ${toolExecution.status}`,
        `ARGS: ${formatToolArgs(toolExecution)}`,
        `RESULT: ${result}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatRecentExecutorResults(context: ProviderContext) {
  if (context.role !== "planner") {
    return "(none)";
  }

  return context.recentExecutorResults
    .map((result) => {
      const artifacts = result.keyArtifacts.length > 0 ? result.keyArtifacts.join(", ") : "(none)";
      const lastTool = result.lastToolResult
        ? `${result.lastToolResult.toolName} ${result.lastToolResult.status}`
        : "(none)";

      return [
        `RUN: ${result.runId}`,
        `SUMMARY: ${result.summary}`,
        `ARTIFACTS: ${artifacts}`,
        `LAST_TOOL: ${lastTool}`,
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

async function createTextResponse(
  input: string,
  operation: ProviderUsage["operation"],
  modelName: string,
) {
  const client = getApiClient();
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
  modelName: string,
  onDelta: (delta: string) => void | Promise<void>,
): Promise<ProviderResponseResult> {
  const client = getApiClient();
  const stream = await client.responses.create({
    model: modelName,
    input,
    stream: true,
  });

  let streamedText = "";

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
    usage: buildUsage(operation, modelName, null),
  };
}

function buildDecisionPrompt(context: ProviderContext, modelName: string) {
  if (context.role === "planner") {
    return buildApiPlannerDecisionPrompt({
      modelName,
      workspaceRoot: AGENT_FS_ROOT,
      summary: context.summary,
      latestUserMessage: context.latestUserMessage,
      recentMessages: formatRecentMessages(context.recentMessages),
      recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
      recentExecutorResults: formatRecentExecutorResults(context),
      lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
      stepIndex: context.stepIndex,
    });
  }

  return buildApiExecutorDecisionPrompt({
    modelName,
    workspaceRoot: AGENT_FS_ROOT,
    summary: context.summary,
    latestUserMessage: context.latestUserMessage,
    delegatedTask: context.delegatedTask,
    successCriteria: context.successCriteria,
    notes: context.notes,
    recentMessages: formatRecentMessages(context.recentMessages),
    recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
    lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
    stepIndex: context.stepIndex,
  });
}

function buildPlannerResponsePrompt(context: ProviderContext, modelName: string) {
  return buildApiResponsePrompt({
    modelName,
    workspaceRoot: AGENT_FS_ROOT,
    summary: context.summary,
    latestUserMessage: context.latestUserMessage,
    recentMessages: formatRecentMessages(context.recentMessages),
    recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
    recentExecutorResults: formatRecentExecutorResults(context),
    lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
  });
}

function extractJsonObject(rawText: string) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("The model returned an empty response.");
  }

  const fencedMatch = /```(?:json)?\s*([\s\S]+?)```/i.exec(trimmed);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    throw new Error("The model did not return a JSON object.");
  }

  return trimmed.slice(objectStart, objectEnd + 1);
}

function parseSubAgentResult(rawText: string, lastToolResult: SubAgentResult["lastToolResult"]): SubAgentResult {
  const parsed = JSON.parse(extractJsonObject(rawText)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Executor result was not an object.");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    throw new Error("Executor result did not include a summary.");
  }

  const keyArtifacts = Array.isArray(parsed.keyArtifacts)
    ? parsed.keyArtifacts.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  return {
    summary,
    keyArtifacts,
    lastToolResult,
  };
}

export const apiProvider: AgentProvider = {
  name: "api",
  async plan(context: ProviderContext): Promise<ProviderDecisionResult> {
    const modelName = getApiModelForRole(context.role);
    const response = await createTextResponse(
      buildDecisionPrompt(context, modelName),
      "decision",
      modelName,
    );

    return {
      decision: parseDecisionResponse(response.text),
      usage: response.usage,
    };
  },
  async respond(context: ProviderContext): Promise<ProviderResponseResult> {
    const modelName = getApiModelForRole(context.role);
    const response = await createTextResponse(
      buildPlannerResponsePrompt(context, modelName),
      "response",
      modelName,
    );

    return {
      content: response.text,
      usage: response.usage,
    };
  },
  async streamResponse(context: ProviderContext, onDelta) {
    const modelName = getApiModelForRole(context.role);
    return createStreamingTextResponse(
      buildPlannerResponsePrompt(context, modelName),
      "response",
      modelName,
      onDelta,
    );
  },
  async summarizeSubAgent(context: ExecutorContext): Promise<ProviderSubAgentResult> {
    const modelName = getApiModelForRole("executor");
    const response = await createTextResponse(
      buildApiExecutorResultPrompt({
        modelName,
        workspaceRoot: AGENT_FS_ROOT,
        summary: context.summary,
        latestUserMessage: context.latestUserMessage,
        delegatedTask: context.delegatedTask,
        successCriteria: context.successCriteria,
        notes: context.notes,
        recentToolExecutions: formatRecentToolExecutions(context.recentToolExecutions),
        lastToolResult: context.lastToolResult ? JSON.stringify(context.lastToolResult, null, 2) : null,
      }),
      "summary",
      modelName,
    );

    return {
      result: parseSubAgentResult(response.text, context.lastToolResult ?? null),
      usage: response.usage,
    };
  },
  async summarize(context: SummaryContext): Promise<ProviderSummaryResult> {
    const modelName = getApiModelForRole("planner");
    const response = await createTextResponse(
      buildApiSummaryPrompt({
        previousSummary: context.previousSummary,
        transcript: formatRecentMessages(context.messages),
      }),
      "summary",
      modelName,
    );

    return {
      summary: response.text.trim(),
      usage: response.usage,
    };
  },
};
