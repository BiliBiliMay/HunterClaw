import type { AgentProvider } from "@/lib/llm/provider";
import { apiProvider } from "@/lib/llm/apiProvider";
import { codexProvider } from "@/lib/llm/codexProvider";

export type ProviderName = "api" | "codex";

export function getConfiguredProviderName(): ProviderName {
  const rawValue = process.env.LLM_PROVIDER?.trim().toLowerCase();

  if (rawValue === "codex") {
    return rawValue;
  }

  return "api";
}

export function getDefaultProvider(): AgentProvider {
  const providerName = getConfiguredProviderName();

  if (providerName === "api") {
    return apiProvider;
  }

  if (providerName === "codex") {
    return codexProvider;
  }

  return apiProvider;
}

export function getExecutorProvider(): AgentProvider {
  return apiProvider;
}
