import type {
  ChatMessage,
  ExecutorContext,
  ProviderSubAgentResult,
  ProviderContext,
  ProviderDecisionResult,
  ProviderResponseResult,
  ProviderSummaryResult,
} from "@/lib/agent/types";

export type SummaryContext = {
  conversationId: string;
  previousSummary: string | null;
  messages: ChatMessage[];
};

export interface AgentProvider {
  name: string;
  plan(context: ProviderContext): Promise<ProviderDecisionResult>;
  respond(context: ProviderContext): Promise<ProviderResponseResult>;
  streamResponse?(
    context: ProviderContext,
    onDelta: (delta: string) => void | Promise<void>,
  ): Promise<ProviderResponseResult>;
  summarizeSubAgent?(context: ExecutorContext): Promise<ProviderSubAgentResult>;
  summarize?(context: SummaryContext): Promise<ProviderSummaryResult>;
}
