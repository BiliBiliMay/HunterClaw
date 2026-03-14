import type { ProviderContext, ProviderDecision } from "@/lib/agent/types";
import type { AgentProvider } from "@/lib/llm/provider";

export async function planNextStep(
  provider: AgentProvider,
  context: ProviderContext,
): Promise<ProviderDecision> {
  if (provider.plan) {
    return provider.plan(context);
  }

  return provider.generateResponse(context);
}

