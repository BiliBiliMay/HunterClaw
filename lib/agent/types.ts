export const DEFAULT_CONVERSATION_ID = "default";

export type ChatRole = "user" | "assistant";
export type MessageKind = "text" | "error";
export type RiskLevel = "low" | "medium" | "high";
export type ToolExecutionStatus = "running" | "success" | "error" | "blocked";
export type ApprovalStatus = "pending" | "approved" | "denied";
export type LlmUsageOperation = "decision" | "summary";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  kind: MessageKind;
  content: string;
  meta: JsonRecord | null;
  createdAt: string;
};

export type ToolCall = {
  toolName: string;
  args: unknown;
  reason: string;
};

export type ToolResult = {
  toolName: string;
  args: unknown;
  riskLevel: RiskLevel;
  status: Exclude<ToolExecutionStatus, "running">;
  output: JsonValue | null;
  error: string | null;
};

export type ApprovalRequestRecord = {
  id: string;
  conversationId: string;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type ToolExecutionRecord = {
  id: string;
  conversationId: string;
  toolName: string;
  args: unknown;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ToolTimelineRecord = {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  summary: string;
  createdAt: string;
  finishedAt: string | null;
};

export type ApprovalSummaryRecord = {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  knownEvents: number;
  unknownEvents: number;
};

export type ConversationUsageSummary = {
  totals: UsageTotals;
  lastTurn: UsageTotals | null;
};

export type LlmUsageEvent = {
  id: string;
  conversationId: string;
  sourceMessageId: string | null;
  providerName: string;
  modelName: string;
  operation: LlmUsageOperation;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
};

export type ProviderUsage = {
  providerName: string;
  modelName: string;
  operation: LlmUsageOperation;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type ProviderDecision =
  | {
      type: "message";
      content: string;
    }
  | ({
      type: "tool_call";
    } & ToolCall);

export type ProviderDecisionResult = {
  decision: ProviderDecision;
  usage: ProviderUsage;
};

export type ProviderSummaryResult = {
  summary: string;
  usage: ProviderUsage;
};

export type ProviderContext = {
  conversationId: string;
  summary: string | null;
  recentMessages: ChatMessage[];
  recentToolExecutions: ToolExecutionRecord[];
  latestUserMessage: string;
  lastToolResult?: ToolResult;
  stepIndex: number;
};

export type AgentContext = {
  conversationId: string;
  summary: string | null;
  recentMessages: ChatMessage[];
  recentToolExecutions: ToolExecutionRecord[];
};

export type HistoryPayload = {
  messages: ChatMessage[];
  toolExecutions: ToolTimelineRecord[];
  pendingApprovals: ApprovalSummaryRecord[];
  usage: ConversationUsageSummary;
};

export type ChatRouteStatus = "completed" | "approval_required" | "error";
export type ApproveRouteStatus = "completed" | "denied" | "error";

export type ChatRouteResponse = HistoryPayload & {
  status: ChatRouteStatus;
  pendingApproval?: ApprovalSummaryRecord;
  error?: string;
};

export type ApproveRouteResponse = HistoryPayload & {
  status: ApproveRouteStatus;
  toolExecution?: ToolTimelineRecord;
  error?: string;
};
