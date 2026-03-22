export const DEFAULT_CONVERSATION_ID = "default";

export type ChatRole = "user" | "assistant";
export type MessageKind = "text" | "error";
export type RiskLevel = "low" | "medium" | "high";
export type ToolExecutionStatus = "running" | "success" | "error" | "blocked";
export type ApprovalStatus = "pending" | "approved" | "denied";
export type LlmUsageOperation = "decision" | "response" | "summary";
export type ChatPhase = "planning" | "running_tool" | "waiting_approval" | "responding";
export type CodeToolAction = "createFile" | "applyPatch";
export type AgentRole = "planner" | "executor";
export type AgentRunStatus =
  | "running"
  | "waiting_approval"
  | "retry_required"
  | "completed"
  | "error";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonRecord = { [key: string]: JsonValue };

export type CodePresentationStats = {
  additions: number;
  deletions: number;
  bytesBefore: number;
  bytesAfter: number;
};

export type ToolPresentationDetails = {
  action: CodeToolAction;
  path: string;
  language: string;
  stats: CodePresentationStats;
  patch: string | null;
  beforeSnippet: string | null;
  afterSnippet: string | null;
  truncated: boolean;
};

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
  retryable: boolean;
};

export type SubAgentResult = {
  summary: string;
  keyArtifacts: string[];
  lastToolResult: ToolResult | null;
};

export type ExecutorRunInput = {
  task: string;
  successCriteria: string;
  notes: string | null;
};

export type PlannerRunInput = {
  latestUserMessage: string;
};

export type AgentRunRecord = {
  id: string;
  conversationId: string;
  parentRunId: string | null;
  sourceMessageId: string | null;
  role: AgentRole;
  status: AgentRunStatus;
  input: unknown;
  result: unknown;
  lastToolExecutionId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type SubAgentResultRecord = SubAgentResult & {
  runId: string;
  createdAt: string;
};

export type ApprovalRequestRecord = {
  id: string;
  conversationId: string;
  agentRunId: string | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation: ToolPresentationDetails | null;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type ToolExecutionRecord = {
  id: string;
  conversationId: string;
  agentRunId: string | null;
  agentRole: AgentRole | null;
  sourceMessageId: string | null;
  toolName: string;
  args: unknown;
  presentation: ToolPresentationDetails | null;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  result: unknown;
  error: string | null;
  retryable: boolean;
  retryOfExecutionId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ToolTimelineRecord = {
  id: string;
  toolName: string;
  agentRole: AgentRole | null;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  summary: string;
  details: ToolPresentationDetails | null;
  error: string | null;
  retryable: boolean;
  retryOfExecutionId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ApprovalSummaryRecord = {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  details: ToolPresentationDetails | null;
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

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  pendingApprovalCount: number;
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
      type: "respond";
      reason: string;
    }
  | {
      type: "delegate";
      task: string;
      successCriteria: string;
      notes?: string | null;
      reason: string;
    }
  | ({
      type: "tool_call";
    } & ToolCall);

export type ProviderDecisionResult = {
  decision: ProviderDecision;
  usage: ProviderUsage;
};

export type ProviderResponseResult = {
  content: string;
  usage: ProviderUsage;
};

export type ProviderSummaryResult = {
  summary: string;
  usage: ProviderUsage;
};

export type ProviderSubAgentResult = {
  result: SubAgentResult;
  usage: ProviderUsage;
};

export type PlannerContext = {
  role: "planner";
  conversationId: string;
  sourceMessageId: string | null;
  summary: string | null;
  recentMessages: ChatMessage[];
  recentToolExecutions: ToolExecutionRecord[];
  recentExecutorResults: SubAgentResultRecord[];
  latestUserMessage: string;
  lastToolResult?: ToolResult;
  stepIndex: number;
};

export type ExecutorContext = {
  role: "executor";
  conversationId: string;
  sourceMessageId: string | null;
  summary: string | null;
  recentMessages: ChatMessage[];
  recentToolExecutions: ToolExecutionRecord[];
  latestUserMessage: string;
  delegatedTask: string;
  successCriteria: string;
  notes: string | null;
  lastToolResult?: ToolResult;
  stepIndex: number;
};

export type ProviderContext = PlannerContext | ExecutorContext;

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

export type ChatRouteStatus = "completed" | "approval_required" | "retry_required" | "error";
export type ApproveRouteStatus = "completed" | "approval_required" | "retry_required" | "denied" | "error";
export type RetryRouteStatus = "completed" | "approval_required" | "retry_required" | "error";

export type ChatRouteResponse = HistoryPayload & {
  status: ChatRouteStatus;
  pendingApproval?: ApprovalSummaryRecord;
  error?: string;
};

export type ApproveRouteResponse = HistoryPayload & {
  status: ApproveRouteStatus;
  pendingApproval?: ApprovalSummaryRecord;
  toolExecution?: ToolTimelineRecord;
  error?: string;
};

export type RetryRouteResponse = HistoryPayload & {
  status: RetryRouteStatus;
  pendingApproval?: ApprovalSummaryRecord;
  toolExecution?: ToolTimelineRecord;
  error?: string;
};

export type ChatStreamEvent =
  | {
      type: "phase.changed";
      phase: ChatPhase;
      label: string;
    }
  | {
      type: "tool.started";
      toolExecution: ToolTimelineRecord;
    }
  | {
      type: "tool.completed";
      toolExecution: ToolTimelineRecord;
    }
  | {
      type: "approval.required";
      approval: ApprovalSummaryRecord;
    }
  | {
      type: "assistant.delta";
      delta: string;
    }
  | {
      type: "assistant.completed";
      message: ChatMessage;
    }
  | {
      type: "usage.updated";
      usage: ConversationUsageSummary;
    }
  | {
      type: "turn.completed";
      status: ChatRouteStatus | ApproveRouteStatus;
      history: HistoryPayload;
    }
  | {
      type: "turn.error";
      error: string;
      history: HistoryPayload | null;
    };
