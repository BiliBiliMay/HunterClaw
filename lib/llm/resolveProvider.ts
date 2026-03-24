import { getApiModelForRole } from "@/lib/llm/apiProvider";
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

function getProviderRuntimeLabel(provider: AgentProvider, role: "planner" | "executor") {
  if (provider.name === "api") {
    return getApiModelForRole(role);
  }

  if (provider.name === "codex") {
    return "Codex (model unavailable)";
  }

  return provider.name;
}

export function getPlannerModelLabel() {
  return getProviderRuntimeLabel(getDefaultProvider(), "planner");
}

export function getExecutorModelLabel() {
  return getProviderRuntimeLabel(getExecutorProvider(), "executor");
}

export function getConfiguredRuntimeLabels() {
  return {
    plannerModelLabel: getPlannerModelLabel(),
    executorModelLabel: getExecutorModelLabel(),
  };
}
