import type { ProviderContext, ProviderDecisionResult } from "@/lib/agent/types";
import type { AgentProvider } from "@/lib/llm/provider";

export async function planNextStep(
  provider: AgentProvider,
  context: ProviderContext,
): Promise<ProviderDecisionResult> {
  return provider.plan(context);
}
