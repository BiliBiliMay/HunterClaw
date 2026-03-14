import type {
  ChatMessage,
  ProviderContext,
  ProviderDecision,
} from "@/lib/agent/types";

export type SummaryContext = {
  conversationId: string;
  previousSummary: string | null;
  messages: ChatMessage[];
};

export interface AgentProvider {
  name: string;
  generateResponse(context: ProviderContext): Promise<ProviderDecision>;
  plan?(context: ProviderContext): Promise<ProviderDecision>;
  summarize?(context: SummaryContext): Promise<string>;
}

