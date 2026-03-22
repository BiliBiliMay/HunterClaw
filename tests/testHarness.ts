import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nowIso } from "@/lib/utils";
import type {
  ProviderSubAgentResult,
  ProviderDecision,
  ProviderDecisionResult,
  ProviderResponseResult,
  ProviderUsage,
  ProviderSummaryResult,
  ProviderContext,
  SubAgentResult,
} from "@/lib/agent/types";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";
import { db, reinitializeDbClientForTests } from "@/lib/db/client";
import { preferences } from "@/lib/db/schema";

type QueueEntry<TContext, TResult> =
  | TResult
  | ((context: TContext) => TResult | Promise<TResult>);

type FakeStreamResponseScript =
  | ProviderResponseResult
  | {
      content: string;
      usage?: Partial<ProviderUsage>;
      deltas?: string[];
    };

function takeQueueEntry<TContext, TResult>(
  queue: QueueEntry<TContext, TResult>[],
  label: string,
  context: TContext,
) {
  const entry = queue.shift();
  if (entry === undefined) {
    throw new Error(`Unexpected fake provider ${label} call.`);
  }

  return typeof entry === "function"
    ? (entry as (value: TContext) => TResult | Promise<TResult>)(context)
    : entry;
}

export function createUsage(
  operation: ProviderUsage["operation"],
  overrides: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    providerName: "fake",
    modelName: "fake-model",
    operation,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    ...overrides,
  };
}

export function createDecisionResult(
  decision: ProviderDecision,
  usageOverrides: Partial<ProviderUsage> = {},
): ProviderDecisionResult {
  return {
    decision,
    usage: createUsage("decision", usageOverrides),
  };
}

export function createResponseResult(
  content: string,
  usageOverrides: Partial<ProviderUsage> = {},
): ProviderResponseResult {
  return {
    content,
    usage: createUsage("response", usageOverrides),
  };
}

export function createSummaryResult(
  summary: string,
  usageOverrides: Partial<ProviderUsage> = {},
): ProviderSummaryResult {
  return {
    summary,
    usage: createUsage("summary", usageOverrides),
  };
}

export function createSubAgentSummaryResult(
  result: SubAgentResult,
  usageOverrides: Partial<ProviderUsage> = {},
): ProviderSubAgentResult {
  return {
    result,
    usage: createUsage("summary", usageOverrides),
  };
}

export function createConversationId(label: string) {
  return `test-${label}-${crypto.randomUUID()}`;
}

export function createFakeProvider({
  name = "fake",
  planDecisions = [],
  responses = [],
  streamResponses = [],
  subAgentSummaries = [],
  summaries,
}: {
  name?: string;
  planDecisions?: QueueEntry<ProviderContext, ProviderDecisionResult>[];
  responses?: QueueEntry<ProviderContext, ProviderResponseResult | string>[];
  streamResponses?: QueueEntry<ProviderContext, FakeStreamResponseScript>[];
  subAgentSummaries?: QueueEntry<ProviderContext, ProviderSubAgentResult | SubAgentResult>[];
  summaries?: QueueEntry<SummaryContext, ProviderSummaryResult | string>[];
} = {}) {
  const calls = {
    plan: [] as ProviderContext[],
    respond: [] as ProviderContext[],
    streamResponse: [] as ProviderContext[],
    summarizeSubAgent: [] as ProviderContext[],
    summarize: [] as SummaryContext[],
  };

  const provider: AgentProvider & { calls: typeof calls } = {
    name,
    calls,
    async plan(context) {
      calls.plan.push(context);
      return await takeQueueEntry(planDecisions, "plan", context);
    },
    async respond(context) {
      calls.respond.push(context);
      const next = await takeQueueEntry(responses, "respond", context);
      return typeof next === "string" ? createResponseResult(next) : next;
    },
    async streamResponse(context, onDelta) {
      calls.streamResponse.push(context);
      const next = await takeQueueEntry(streamResponses, "stream response", context);
      const response: ProviderResponseResult = {
        content: next.content,
        usage: createUsage("response", next.usage ?? {}),
      };
      const deltas = "deltas" in next && next.deltas ? next.deltas : [response.content];

      for (const delta of deltas) {
        await onDelta(delta);
      }

      return response;
    },
    async summarizeSubAgent(context) {
      calls.summarizeSubAgent.push(context);
      const next = await takeQueueEntry(subAgentSummaries, "sub-agent summary", context);
      return "result" in next ? next : createSubAgentSummaryResult(next);
    },
  };

  if (summaries) {
    provider.summarize = async (context) => {
      calls.summarize.push(context);
      const next = await takeQueueEntry(summaries, "summary", context);
      return typeof next === "string" ? createSummaryResult(next) : next;
    };
  }

  return provider;
}

export function createTestHarness(label: string) {
  let tempRoot = "";
  let fsRoot = "";
  let dbPath = "";
  const originalEnv = new Map<string, string | undefined>();

  function rememberEnv(key: string) {
    if (!originalEnv.has(key)) {
      originalEnv.set(key, process.env[key]);
    }
  }

  return {
    get tempRoot() {
      return tempRoot;
    },
    get fsRoot() {
      return fsRoot;
    },
    get dbPath() {
      return dbPath;
    },
    async setup() {
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
      fsRoot = path.join(tempRoot, "workspace");
      dbPath = path.join(tempRoot, "agent.db");
      await fs.mkdir(fsRoot, { recursive: true });
      reinitializeDbClientForTests({
        nextDbPath: dbPath,
        nextFsRoot: fsRoot,
      });
    },
    async teardown() {
      for (const [key, value] of originalEnv.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      originalEnv.clear();

      if (tempRoot) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
    async writeWorkspaceFile(relativePath: string, content: string) {
      const absolutePath = path.join(fsRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      return absolutePath;
    },
    async readWorkspaceFile(relativePath: string) {
      return fs.readFile(path.join(fsRoot, relativePath), "utf8");
    },
    async pathExists(relativePath: string) {
      try {
        await fs.access(path.join(fsRoot, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async createHostDirectory(relativePath: string) {
      const absolutePath = path.join(tempRoot, relativePath);
      await fs.mkdir(absolutePath, { recursive: true });
      return absolutePath;
    },
    async writeHostFile(relativePath: string, content: string) {
      const absolutePath = path.join(tempRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      return absolutePath;
    },
    setEnv(key: string, value?: string) {
      rememberEnv(key);

      if (value === undefined) {
        delete process.env[key];
        return;
      }

      process.env[key] = value;
    },
    async setPreference(key: string, value: string) {
      db.insert(preferences)
        .values({
          key,
          value,
          updatedAt: nowIso(),
        })
        .onConflictDoUpdate({
          target: preferences.key,
          set: {
            value,
            updatedAt: nowIso(),
          },
        })
        .run();
    },
  };
}
