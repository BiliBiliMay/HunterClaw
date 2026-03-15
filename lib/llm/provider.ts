import type {
  ChatMessage,
  ProviderContext,
  ProviderDecisionResult,
  ProviderSummaryResult,
} from "@/lib/agent/types";

export type SummaryContext = {
  conversationId: string;
  previousSummary: string | null;
  messages: ChatMessage[];
};

export interface AgentProvider {
  name: string;
  generateResponse(context: ProviderContext): Promise<ProviderDecisionResult>;
  plan?(context: ProviderContext): Promise<ProviderDecisionResult>;
  summarize?(context: SummaryContext): Promise<ProviderSummaryResult>;
}
