"use client";

import {
  FormEvent,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CodeChangePreview } from "@/components/chat/code-change-preview";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import type {
  ApprovalSummaryRecord,
  ChatMessage,
  ChatPhase,
  ChatStreamEvent,
  ConversationSummary,
  ConversationUsageSummary,
  HistoryPayload,
  ToolTimelineRecord,
  UsageTotals,
} from "@/lib/agent/types";
import {
  consumeSseStream,
  fetchJsonOrTextError,
} from "@/lib/chat/clientTransport";

type TimelineEntry =
  | { type: "message"; createdAt: string; message: ChatMessage; streaming?: boolean }
  | { type: "tool"; createdAt: string; toolExecution: ToolTimelineRecord; live?: boolean }
  | { type: "approval"; createdAt: string; approval: ApprovalSummaryRecord; live?: boolean };

type ConversationsPayload = {
  conversations: ConversationSummary[];
};

type CreateConversationPayload = {
  conversation: ConversationSummary;
};

const NEW_CONVERSATION_TITLE = "New chat";

const emptyUsageTotals: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  knownEvents: 0,
  unknownEvents: 0,
};

const defaultUsage: ConversationUsageSummary = {
  totals: emptyUsageTotals,
  lastTurn: null,
};

const defaultHistory: HistoryPayload = {
  messages: [],
  toolExecutions: [],
  pendingApprovals: [],
  usage: defaultUsage,
};

const phaseTitles: Record<ChatPhase, string> = {
  planning: "Thinking",
  running_tool: "Running tool",
  waiting_approval: "Waiting for approval",
  responding: "Responding",
};

function formatNumber(value: number) {
  return value.toLocaleString();
}

function truncateText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatConversationTimestamp(value: string | null) {
  if (!value) {
    return "No activity yet";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "No activity yet";
  }
}

function sortConversationsRecentFirst(conversations: ConversationSummary[]) {
  return [...conversations].sort((left, right) => {
    const leftTimestamp = left.lastActivityAt ?? left.createdAt ?? "";
    const rightTimestamp = right.lastActivityAt ?? right.createdAt ?? "";

    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp.localeCompare(leftTimestamp);
    }

    return left.title.localeCompare(right.title);
  });
}

function buildConversationFallback(
  conversationId: string,
  history: HistoryPayload,
): ConversationSummary {
  const firstUserMessage = history.messages.find((message) => message.role === "user");
  const latestMessage = [...history.messages].reverse().find((message) => message.content.trim());
  const timestamps = [
    ...history.messages.map((message) => message.createdAt),
    ...history.toolExecutions.map((toolExecution) => toolExecution.createdAt),
    ...history.pendingApprovals.map((approval) => approval.createdAt),
  ].sort((left, right) => left.localeCompare(right));

  return {
    id: conversationId,
    title:
      truncateText(
        firstUserMessage?.content ??
          (conversationId === DEFAULT_CONVERSATION_ID ? "Default conversation" : NEW_CONVERSATION_TITLE),
        48,
      ) ??
      (conversationId === DEFAULT_CONVERSATION_ID ? "Default conversation" : NEW_CONVERSATION_TITLE),
    preview: truncateText(latestMessage?.content ?? "", 96),
    createdAt: timestamps[0] ?? null,
    lastActivityAt: timestamps[timestamps.length - 1] ?? null,
    messageCount: history.messages.length,
    pendingApprovalCount: history.pendingApprovals.length,
  };
}

function mergeConversations(
  conversations: ConversationSummary[],
  activeConversationId: string,
  history: HistoryPayload,
) {
  if (conversations.some((conversation) => conversation.id === activeConversationId)) {
    return conversations;
  }

  return [buildConversationFallback(activeConversationId, history), ...conversations];
}

function formatToolHeadline(toolExecution: ToolTimelineRecord) {
  if (toolExecution.status === "running") {
    return `Using ${toolExecution.toolName}`;
  }

  if (toolExecution.status === "blocked") {
    return `Blocked ${toolExecution.toolName}`;
  }

  if (toolExecution.status === "error") {
    return `Error in ${toolExecution.toolName}`;
  }

  return `Used ${toolExecution.toolName}`;
}

function formatRiskLabel(riskLevel: ToolTimelineRecord["riskLevel"]) {
  return `${riskLevel} risk`;
}

function buildOptimisticUserMessage(message: string, conversationId: string): ChatMessage {
  return {
    id: `local-user-${crypto.randomUUID()}`,
    conversationId,
    role: "user",
    kind: "text",
    content: message,
    meta: null,
    createdAt: new Date().toISOString(),
  };
}

function upsertToolExecution(items: ToolTimelineRecord[], toolExecution: ToolTimelineRecord) {
  const next = items.filter((item) => item.id !== toolExecution.id);
  next.push(toolExecution);
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertApproval(items: ApprovalSummaryRecord[], approval: ApprovalSummaryRecord) {
  const next = items.filter((item) => item.id !== approval.id);
  next.push(approval);
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function getPendingApprovalCount(history: HistoryPayload, liveApprovals: ApprovalSummaryRecord[]) {
  return new Set([
    ...history.pendingApprovals.map((approval) => approval.id),
    ...liveApprovals.map((approval) => approval.id),
  ]).size;
}

function ConversationRail({
  activeConversationId,
  conversations,
  isInitializing,
  onCreateConversation,
  onSelectConversation,
  providerName,
}: {
  activeConversationId: string | null;
  conversations: ConversationSummary[];
  isInitializing: boolean;
  onCreateConversation: () => Promise<void>;
  onSelectConversation: (conversationId: string) => void;
  providerName: string;
}) {
  return (
    <aside className="flex w-full flex-col border-b border-[var(--hc-sidebar-border)] bg-[var(--hc-sidebar)] text-white md:h-screen md:w-80 md:flex-none md:border-b-0 md:border-r">
      <div className="border-b border-[var(--hc-sidebar-border)] px-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">HunterClaw</p>
        <p className="mt-2 text-sm text-slate-300">Local-first coding agent</p>
        <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">Provider</p>
        <p className="mt-1 text-sm text-white">{providerName}</p>
        <button
          className="mt-4 inline-flex w-full items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isInitializing}
          onClick={() => {
            void onCreateConversation();
          }}
          type="button"
        >
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <nav className="space-y-1.5">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId;

            return (
              <button
                className={`w-full rounded-2xl px-3 py-3 text-left transition ${
                  isActive
                    ? "bg-white/[0.12] text-white"
                    : "text-slate-300 hover:bg-white/[0.07] hover:text-white"
                }`}
                key={conversation.id}
                onClick={() => onSelectConversation(conversation.id)}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{conversation.title}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {conversation.preview ?? "No messages yet"}
                    </p>
                  </div>
                  {conversation.pendingApprovalCount > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-900">
                      {conversation.pendingApprovalCount}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-slate-500">
                  <span>{conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"}</span>
                  <span>{formatConversationTimestamp(conversation.lastActivityAt ?? conversation.createdAt)}</span>
                </div>
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}

function TokenPill({ totalTokens }: { totalTokens: number }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--hc-border)] bg-[var(--hc-panel-subtle)] px-3 py-1.5 text-xs text-[var(--hc-muted)]">
      <span className="font-semibold text-[var(--hc-text)]">{formatNumber(totalTokens)}</span>
      <span>tokens</span>
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const isError = message.kind === "error";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-3xl rounded-[1.75rem] px-5 py-4 text-sm leading-7 shadow-sm ${
          isUser
            ? "bg-[#202123] text-white"
            : isError
              ? "border border-rose-200 bg-rose-50 text-rose-900"
              : "border border-[var(--hc-border)] bg-[var(--hc-panel)] text-[var(--hc-text)]"
        }`}
      >
        {!isUser ? (
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--hc-muted)]">
            <span>{isError ? "Assistant error" : "HunterClaw"}</span>
            {streaming ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> : null}
          </div>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  );
}

function ToolActivity({
  live,
  toolExecution,
}: {
  live?: boolean;
  toolExecution: ToolTimelineRecord;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-3xl rounded-[1.5rem] border border-[var(--hc-border)] bg-[var(--hc-panel-subtle)] px-4 py-3 text-sm text-[var(--hc-text)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-200 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-700">
            {live ? "Live" : "Tool"}
          </span>
          <span className="font-medium">{formatToolHeadline(toolExecution)}</span>
          <span className="rounded-full border border-[var(--hc-border)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--hc-muted)]">
            {toolExecution.status}
          </span>
          <span className="rounded-full border border-[var(--hc-border)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--hc-muted)]">
            {formatRiskLabel(toolExecution.riskLevel)}
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-700">{toolExecution.summary}</p>
        {toolExecution.toolName === "codeTool" && toolExecution.details ? (
          <CodeChangePreview defaultOpen={Boolean(live)} details={toolExecution.details} />
        ) : null}
      </div>
    </div>
  );
}

function ApprovalNotice({
  approval,
  live,
  isBusy,
  onDecision,
}: {
  approval: ApprovalSummaryRecord;
  live?: boolean;
  isBusy: boolean;
  onDecision: (requestId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-3xl rounded-[1.5rem] border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-amber-800">
            {live ? "Approval needed" : "Pending approval"}
          </span>
          <span className="font-medium">{approval.toolName}</span>
          <span className="rounded-full border border-amber-200 px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-amber-800">
            {formatRiskLabel(approval.riskLevel)}
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-amber-950">{approval.summary}</p>
        {approval.toolName === "codeTool" && approval.details ? (
          <CodeChangePreview defaultOpen details={approval.details} />
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-full bg-[#202123] px-4 py-2 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-slate-400"
            disabled={isBusy}
            onClick={() => onDecision(approval.id, "approve")}
            type="button"
          >
            {isBusy ? "Working..." : "Approve"}
          </button>
          <button
            className="rounded-full border border-amber-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-amber-300 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isBusy}
            onClick={() => onDecision(approval.id, "deny")}
            type="button"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveStatusRow({
  phase,
}: {
  phase: { phase: ChatPhase; label: string } | null;
}) {
  if (!phase) {
    return null;
  }

  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-3 rounded-full border border-[var(--hc-border)] bg-[var(--hc-panel-subtle)] px-4 py-2 text-sm text-[var(--hc-text)]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        <span className="font-medium">{phaseTitles[phase.phase]}</span>
        <span className="text-[var(--hc-muted)]">{phase.label}</span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[42vh] items-center justify-center">
      <div className="max-w-xl rounded-[2rem] border border-dashed border-[var(--hc-border-strong)] bg-[var(--hc-panel-subtle)] px-8 py-10 text-center">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-[var(--hc-muted)]">New conversation</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--hc-text)]">How can HunterClaw help?</h2>
        <p className="mt-4 text-sm leading-7 text-[var(--hc-muted)]">
          Ask it to inspect the repo, debug a behavior, or implement a change while showing live tool activity as it works.
        </p>
      </div>
    </div>
  );
}

export function ChatApp({ providerName }: { providerName: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedConversationId = searchParams.get("conversationId")?.trim() || null;
  const bootstrapConversationRef = useRef<Promise<ConversationSummary> | null>(null);
  const activeConversationIdRef = useRef<string | null>(requestedConversationId);
  const historyRequestRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(requestedConversationId);
  const [history, setHistory] = useState<HistoryPayload>(defaultHistory);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [livePhase, setLivePhase] = useState<{ phase: ChatPhase; label: string } | null>(null);
  const [liveAssistant, setLiveAssistant] = useState<{ content: string; createdAt: string } | null>(null);
  const [liveTools, setLiveTools] = useState<ToolTimelineRecord[]>([]);
  const [liveApprovals, setLiveApprovals] = useState<ApprovalSummaryRecord[]>([]);
  const [liveUsage, setLiveUsage] = useState<ConversationUsageSummary | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<ChatMessage[]>([]);

  const visibleConversations = useMemo(() => {
    if (!activeConversationId) {
      return conversations;
    }

    return mergeConversations(conversations, activeConversationId, history);
  }, [activeConversationId, conversations, history]);
  const selectedConversation = useMemo(() => {
    if (!activeConversationId) {
      return null;
    }

    return visibleConversations.find((conversation) => conversation.id === activeConversationId)
      ?? buildConversationFallback(activeConversationId, history);
  }, [activeConversationId, history, visibleConversations]);
  const displayedUsage = liveUsage ?? history.usage;
  const pendingApprovalCount = getPendingApprovalCount(history, liveApprovals);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    bottomAnchorRef.current?.scrollIntoView({
      block: "end",
    });
  }, [history, liveApprovals, liveAssistant, livePhase, liveTools, optimisticMessages]);

  function clearLiveState() {
    setLivePhase(null);
    setLiveAssistant(null);
    setLiveTools([]);
    setLiveApprovals([]);
    setLiveUsage(null);
    setOptimisticMessages([]);
  }

  function abortActiveStream() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setIsSubmitting(false);
    setActionLoadingId(null);
    clearLiveState();
  }

  function navigateToConversation(conversationId: string, replace = false) {
    if (conversationId === activeConversationIdRef.current && !replace) {
      return;
    }

    abortActiveStream();
    setError(null);
    setHistory(defaultHistory);
    setActiveConversationId(conversationId);

    startTransition(() => {
      const url = `/?conversationId=${conversationId}`;
      if (replace) {
        router.replace(url);
      } else {
        router.push(url);
      }
    });
  }

  async function fetchConversations() {
    const payload = await fetchJsonOrTextError<ConversationsPayload>(
      "/api/conversations",
      {
        cache: "no-store",
      },
      "Failed to load conversations",
    );

    return sortConversationsRecentFirst(payload.conversations);
  }

  async function createConversationOnServer() {
    const payload = await fetchJsonOrTextError<CreateConversationPayload>(
      "/api/conversations",
      {
        method: "POST",
      },
      "Failed to create conversation",
    );

    return payload.conversation;
  }

  async function refreshConversations() {
    const nextConversations = await fetchConversations();
    setConversations(nextConversations);
    return nextConversations;
  }

  async function refreshConversationsSafely() {
    try {
      await refreshConversations();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh conversations.");
    }
  }

  async function ensureBootstrapConversation() {
    if (!bootstrapConversationRef.current) {
      bootstrapConversationRef.current = createConversationOnServer().finally(() => {
        bootstrapConversationRef.current = null;
      });
    }

    return bootstrapConversationRef.current;
  }

  async function loadHistory(conversationId: string) {
    const requestId = historyRequestRef.current + 1;
    historyRequestRef.current = requestId;
    setIsLoadingHistory(true);

    try {
      const payload = await fetchJsonOrTextError<HistoryPayload>(
        `/api/history?conversationId=${encodeURIComponent(conversationId)}`,
        {
          cache: "no-store",
        },
        "Failed to load conversation history",
      );

      if (historyRequestRef.current !== requestId || activeConversationIdRef.current !== conversationId) {
        return;
      }

      setHistory(payload);
      clearLiveState();
      setError(null);
    } finally {
      if (historyRequestRef.current === requestId) {
        setIsLoadingHistory(false);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      setIsInitializing(true);

      try {
        const nextConversations = await refreshConversations();
        let nextConversationId = requestedConversationId;

        if (!nextConversationId || !nextConversations.some((conversation) => conversation.id === nextConversationId)) {
          if (nextConversations.length > 0) {
            nextConversationId = nextConversations[0].id;
          } else {
            const createdConversation = await ensureBootstrapConversation();

            if (cancelled) {
              return;
            }

            const seededConversations = sortConversationsRecentFirst([createdConversation]);
            setConversations(seededConversations);
            nextConversationId = createdConversation.id;
          }
        }

        if (cancelled || !nextConversationId) {
          return;
        }

        setActiveConversationId(nextConversationId);

        if (requestedConversationId !== nextConversationId) {
          startTransition(() => {
            router.replace(`/?conversationId=${nextConversationId}`);
          });
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unexpected error.");
        }
      } finally {
        if (!cancelled) {
          setIsInitializing(false);
        }
      }
    }

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [requestedConversationId, router]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    let cancelled = false;

    void loadHistory(activeConversationId).catch((loadError: Error) => {
      if (!cancelled) {
        setError(loadError.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  async function handleStreamEvent(event: ChatStreamEvent) {
    if (event.type === "phase.changed") {
      setLivePhase({
        phase: event.phase,
        label: event.label,
      });
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.completed") {
      setLiveTools((current) => upsertToolExecution(current, event.toolExecution));
      return;
    }

    if (event.type === "approval.required") {
      setLiveApprovals((current) => upsertApproval(current, event.approval));
      return;
    }

    if (event.type === "assistant.delta") {
      setLiveAssistant((current) => ({
        content: `${current?.content ?? ""}${event.delta}`,
        createdAt: current?.createdAt ?? new Date().toISOString(),
      }));
      return;
    }

    if (event.type === "assistant.completed") {
      setLiveAssistant({
        content: event.message.content,
        createdAt: event.message.createdAt,
      });
      return;
    }

    if (event.type === "usage.updated") {
      setLiveUsage(event.usage);
      return;
    }

    if (event.type === "turn.completed") {
      setHistory(event.history);
      clearLiveState();
      setIsSubmitting(false);
      setActionLoadingId(null);
      setError(null);
      await refreshConversationsSafely();
      return;
    }

    setIsSubmitting(false);
    setActionLoadingId(null);
    setError(event.error);
    if (event.history) {
      setHistory(event.history);
    }
    clearLiveState();
    await refreshConversationsSafely();
  }

  async function runStream(endpoint: string, body: Record<string, string>, fallbackMessage: string) {
    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      await consumeSseStream({
        input: endpoint,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
        fallbackMessage,
        onEvent: handleStreamEvent,
      });
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage || !activeConversationId) {
      return;
    }

    abortActiveStream();
    setIsSubmitting(true);
    setError(null);
    setLivePhase({
      phase: "planning",
      label: "Planning",
    });
    setOptimisticMessages([buildOptimisticUserMessage(trimmedMessage, activeConversationId)]);
    setMessage("");

    try {
      await runStream(
        "/api/chat/stream",
        {
          message: trimmedMessage,
          conversationId: activeConversationId,
        },
        "Failed to send message",
      );
    } catch (submitError) {
      if (submitError instanceof Error && submitError.name === "AbortError") {
        return;
      }

      setError(submitError instanceof Error ? submitError.message : "Unexpected error.");
      setIsSubmitting(false);
      clearLiveState();
      await refreshConversationsSafely();
    }
  }

  async function handleDecision(requestId: string, decision: "approve" | "deny") {
    setActionLoadingId(requestId);
    setError(null);
    setLivePhase({
      phase: decision === "approve" ? "running_tool" : "responding",
      label: decision === "approve" ? "Resuming after approval" : "Applying denial",
    });

    try {
      await runStream(
        "/api/approve/stream",
        {
          requestId,
          decision,
        },
        "Failed to process approval",
      );
    } catch (decisionError) {
      if (decisionError instanceof Error && decisionError.name === "AbortError") {
        return;
      }

      setError(decisionError instanceof Error ? decisionError.message : "Unexpected error.");
      setActionLoadingId(null);
      clearLiveState();
      await refreshConversationsSafely();
    }
  }

  async function handleCreateConversation() {
    setError(null);

    try {
      const conversation = await createConversationOnServer();
      setConversations((current) =>
        sortConversationsRecentFirst([
          conversation,
          ...current.filter((item) => item.id !== conversation.id),
        ]),
      );
      navigateToConversation(conversation.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Unexpected error.");
    }
  }

  const entries = useMemo<TimelineEntry[]>(() => {
    const streamingAssistant = liveAssistant && activeConversationId
      ? {
          type: "message" as const,
          createdAt: liveAssistant.createdAt,
          streaming: true,
          message: {
            id: "live-assistant",
            conversationId: activeConversationId,
            role: "assistant" as const,
            kind: "text" as const,
            content: liveAssistant.content,
            meta: null,
            createdAt: liveAssistant.createdAt,
          },
        }
      : null;

    return [
      ...history.messages.map((item) => ({
        type: "message" as const,
        createdAt: item.createdAt,
        message: item,
      })),
      ...optimisticMessages.map((item) => ({
        type: "message" as const,
        createdAt: item.createdAt,
        message: item,
      })),
      ...history.toolExecutions.map((item) => ({
        type: "tool" as const,
        createdAt: item.createdAt,
        toolExecution: item,
      })),
      ...liveTools.map((item) => ({
        type: "tool" as const,
        createdAt: item.createdAt,
        toolExecution: item,
        live: true,
      })),
      ...history.pendingApprovals.map((item) => ({
        type: "approval" as const,
        createdAt: item.createdAt,
        approval: item,
      })),
      ...liveApprovals.map((item) => ({
        type: "approval" as const,
        createdAt: item.createdAt,
        approval: item,
        live: true,
      })),
      ...(streamingAssistant ? [streamingAssistant] : []),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [activeConversationId, history, liveApprovals, liveAssistant, liveTools, optimisticMessages]);

  const liveStatus = useMemo(() => {
    if (!livePhase) {
      return null;
    }

    if (liveAssistant || liveTools.some((tool) => tool.status === "running") || liveApprovals.length > 0) {
      return null;
    }

    return livePhase;
  }, [liveApprovals.length, liveAssistant, livePhase, liveTools]);

  const isComposerDisabled =
    isInitializing || isLoadingHistory || isSubmitting || Boolean(actionLoadingId) || !activeConversationId;
  const composerHint = isInitializing
    ? "Preparing session..."
    : isLoadingHistory
      ? "Loading conversation..."
      : selectedConversation
        ? selectedConversation.title
        : "Create a conversation to begin.";

  return (
    <main className="min-h-screen bg-[var(--hc-page)] text-[var(--hc-text)]">
      <div className="flex min-h-screen flex-col md:flex-row">
        <ConversationRail
          activeConversationId={activeConversationId}
          conversations={visibleConversations}
          isInitializing={isInitializing}
          onCreateConversation={handleCreateConversation}
          onSelectConversation={navigateToConversation}
          providerName={providerName}
        />

        <section className="flex min-h-screen min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 border-b border-[var(--hc-border)] bg-white/90 backdrop-blur">
            <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--hc-muted)]">Conversation</p>
                  <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--hc-text)]">
                    {selectedConversation?.title ?? (isInitializing ? "Preparing session..." : NEW_CONVERSATION_TITLE)}
                  </h1>
                  {selectedConversation ? (
                    <p className="mt-1 text-sm text-[var(--hc-muted)]">
                      {selectedConversation.messageCount} message{selectedConversation.messageCount === 1 ? "" : "s"}
                      {" · "}
                      {formatConversationTimestamp(selectedConversation.lastActivityAt ?? selectedConversation.createdAt)}
                    </p>
                  ) : null}
                </div>
                <TokenPill totalTokens={displayedUsage.totals.totalTokens} />
              </div>

              <div className="text-right text-sm text-[var(--hc-muted)]">
                <div className="font-medium uppercase tracking-[0.16em] text-slate-500">{providerName}</div>
                <div>
                  {pendingApprovalCount > 0
                    ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? "" : "s"} waiting`
                    : "Ready"}
                </div>
              </div>
            </div>
          </header>

          {error ? (
            <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:px-6">
              <div className="mx-auto max-w-4xl">{error}</div>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 sm:px-6">
              {entries.length === 0 && !liveStatus ? <EmptyState /> : null}

              <div className="space-y-5">
                {entries.map((entry) => {
                  if (entry.type === "message") {
                    return <MessageBubble key={entry.message.id} message={entry.message} streaming={entry.streaming} />;
                  }

                  if (entry.type === "tool") {
                    return (
                      <ToolActivity
                        key={`${entry.toolExecution.id}-${entry.live ? "live" : "history"}`}
                        live={entry.live}
                        toolExecution={entry.toolExecution}
                      />
                    );
                  }

                  return (
                    <ApprovalNotice
                      approval={entry.approval}
                      isBusy={actionLoadingId === entry.approval.id}
                      key={`${entry.approval.id}-${entry.live ? "live" : "history"}`}
                      live={entry.live}
                      onDecision={handleDecision}
                    />
                  );
                })}

                {liveStatus ? <LiveStatusRow phase={liveStatus} /> : null}
                <div ref={bottomAnchorRef} />
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--hc-border)] bg-white">
            <form className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6" onSubmit={handleSubmit}>
              <div className="rounded-[1.75rem] border border-[var(--hc-border-strong)] bg-[var(--hc-panel)] p-3 shadow-sm">
                <textarea
                  className="min-h-28 w-full resize-none bg-transparent px-3 py-2 text-sm leading-7 text-[var(--hc-text)] outline-none placeholder:text-slate-400"
                  disabled={isComposerDisabled}
                  id="message"
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Message HunterClaw"
                  value={message}
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hc-border)] px-3 pt-3">
                  <p className="text-sm text-[var(--hc-muted)]">{composerHint}</p>
                  <button
                    className="rounded-full bg-[#202123] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-slate-400"
                    disabled={isComposerDisabled}
                    type="submit"
                  >
                    {isSubmitting || actionLoadingId ? "Working..." : "Send"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
