import type { ProviderContext } from "@/lib/agent/types";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";

export const codexProvider: AgentProvider = {
  name: "codex",
  async plan(_context: ProviderContext) {
    // TODO: Wire this to an authenticated Codex or ChatGPT session and map model output
    // into the ProviderDecisionResult shape used by the agent loop, including usage.
    throw new Error("Codex provider is not implemented in this MVP. Use the API provider.");
  },
  async respond(_context: ProviderContext) {
    // TODO: Reuse the authenticated provider flow for final assistant responses.
    throw new Error("Codex provider responses are not implemented in this MVP.");
  },
  async summarize(_context: SummaryContext) {
    // TODO: Reuse the same authenticated provider flow for summary generation when the
    // Codex-backed integration is added, including usage reporting.
    throw new Error("Codex provider summarization is not implemented in this MVP.");
  },
};
