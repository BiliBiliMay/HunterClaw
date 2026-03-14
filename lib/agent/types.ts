export const DEFAULT_CONVERSATION_ID = "default";

export type ChatRole = "user" | "assistant";
export type MessageKind = "text" | "error";
export type RiskLevel = "low" | "medium" | "high";
export type ToolExecutionStatus = "running" | "success" | "error" | "blocked";
export type ApprovalStatus = "pending" | "approved" | "denied";

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

export type ProviderDecision =
  | {
      type: "message";
      content: string;
    }
  | ({
      type: "tool_call";
    } & ToolCall);

export type ProviderContext = {
  conversationId: string;
  summary: string | null;
  recentMessages: ChatMessage[];
  latestUserMessage: string;
  lastToolResult?: ToolResult;
};

export type AgentContext = {
  conversationId: string;
  summary: string | null;
  recentMessages: ChatMessage[];
};

export type HistoryPayload = {
  messages: ChatMessage[];
  toolExecutions: ToolExecutionRecord[];
  pendingApprovals: ApprovalRequestRecord[];
};

export type ChatRouteStatus = "completed" | "approval_required" | "error";
export type ApproveRouteStatus = "completed" | "denied" | "error";

export type ChatRouteResponse = HistoryPayload & {
  status: ChatRouteStatus;
  pendingApproval?: ApprovalRequestRecord;
  error?: string;
};

export type ApproveRouteResponse = HistoryPayload & {
  status: ApproveRouteStatus;
  toolExecution?: ToolExecutionRecord;
  error?: string;
};

