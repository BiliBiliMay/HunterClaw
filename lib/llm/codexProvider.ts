import type { ProviderContext } from "@/lib/agent/types";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";

export const codexProvider: AgentProvider = {
  name: "codex",
  async generateResponse(_context: ProviderContext) {
    // TODO: Wire this to an authenticated Codex or ChatGPT session and map model output
    // into the ProviderDecision shape used by the agent loop.
    throw new Error("Codex provider is not implemented in this MVP. Use the local provider.");
  },
  async plan(context: ProviderContext) {
    return this.generateResponse(context);
  },
  async summarize(_context: SummaryContext) {
    // TODO: Reuse the same authenticated provider flow for summary generation when the
    // Codex-backed integration is added.
    throw new Error("Codex provider summarization is not implemented in this MVP.");
  },
};

