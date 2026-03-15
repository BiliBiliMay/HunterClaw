"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import type {
  ApprovalSummaryRecord,
  ApproveRouteResponse,
  ChatMessage,
  ChatRouteResponse,
  ConversationUsageSummary,
  HistoryPayload,
  ToolTimelineRecord,
  UsageTotals,
} from "@/lib/agent/types";

type TimelineEntry =
  | { type: "message"; createdAt: string; message: ChatMessage }
  | { type: "tool"; createdAt: string; toolExecution: ToolTimelineRecord }
  | { type: "approval"; createdAt: string; approval: ApprovalSummaryRecord };

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

function hasError(payload: { error?: string }): payload is { error: string } {
  return Boolean(payload.error);
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClasses = {
    neutral: "bg-white/80 text-slate-700 border border-slate-200",
    success: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    warning: "bg-amber-50 text-amber-800 border border-amber-200",
    danger: "bg-rose-50 text-rose-700 border border-rose-200",
  };

  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${toneClasses[tone]}`}>
      {label}
    </span>
  );
}

function UsageCard({
  title,
  usage,
  prominent = false,
}: {
  title: string;
  usage: UsageTotals | null;
  prominent?: boolean;
}) {
  if (!usage) {
    return (
      <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
        <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">{title}</p>
        <p className="mt-3 text-2xl font-semibold text-white">-</p>
      </div>
    );
  }

  return (
    <div className={`rounded-[1.6rem] border ${prominent ? "border-sky-400/20 bg-sky-400/10" : "border-white/10 bg-white/5"} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.26em] text-slate-400">{title}</p>
        {usage.unknownEvents > 0 ? <StatusPill label="Partial" tone="warning" /> : null}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-white">
        {formatNumber(usage.totalTokens)}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-300">
        <div className="rounded-2xl bg-slate-950/35 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Input</p>
          <p className="mt-1 font-medium text-white">{formatNumber(usage.inputTokens)}</p>
        </div>
        <div className="rounded-2xl bg-slate-950/35 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Output</p>
          <p className="mt-1 font-medium text-white">{formatNumber(usage.outputTokens)}</p>
        </div>
      </div>
    </div>
  );
}

function renderToolStatusTone(status: ToolTimelineRecord["status"]) {
  if (status === "success") {
    return "success";
  }

  if (status === "blocked") {
    return "warning";
  }

  if (status === "error") {
    return "danger";
  }

  return "neutral";
}

function renderRiskTone(riskLevel: ToolTimelineRecord["riskLevel"]) {
  return riskLevel === "high" ? "danger" : riskLevel === "medium" ? "warning" : "neutral";
}

function Timeline({
  entries,
  onDecision,
  actionLoadingId,
}: {
  entries: TimelineEntry[];
  onDecision: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  actionLoadingId: string | null;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-[1.75rem] border border-dashed border-[var(--hc-border-strong)] bg-[var(--hc-panel-soft)] px-6 py-10 text-sm text-[var(--hc-muted)]">
        Ask the agent to inspect the repo, explain code, debug a behavior, or make a change. Tool activity will appear inline as compact status updates.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {entries.map((entry) => {
        if (entry.type === "message") {
          const isUser = entry.message.role === "user";

          return (
            <div className={`flex ${isUser ? "justify-end" : "justify-start"}`} key={entry.message.id}>
              <div
                className={`max-w-3xl rounded-[1.75rem] px-5 py-4 shadow-panel ${
                  isUser
                    ? "bg-[var(--hc-ink)] text-white"
                    : entry.message.kind === "error"
                      ? "border border-rose-200 bg-rose-50 text-rose-900"
                      : "border border-[var(--hc-border)] bg-[var(--hc-surface)] text-[var(--hc-text)]"
                }`}
              >
                <div className="mb-2 text-[11px] uppercase tracking-[0.24em] text-slate-400">
                  {isUser ? "User" : entry.message.kind === "error" ? "Assistant error" : "Assistant"}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6">{entry.message.content}</p>
              </div>
            </div>
          );
        }

        if (entry.type === "tool") {
          return (
            <div
              className="rounded-[1.6rem] border border-[var(--hc-border)] bg-[var(--hc-panel-soft)] px-5 py-4 text-sm text-[var(--hc-text)]"
              key={entry.toolExecution.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Tool activity" tone="neutral" />
                <span className="font-semibold text-slate-900">{entry.toolExecution.toolName}</span>
                <StatusPill label={entry.toolExecution.status} tone={renderToolStatusTone(entry.toolExecution.status)} />
                <StatusPill label={entry.toolExecution.riskLevel} tone={renderRiskTone(entry.toolExecution.riskLevel)} />
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">{entry.toolExecution.summary}</p>
            </div>
          );
        }

        const isBusy = actionLoadingId === entry.approval.id;

        return (
          <div
            className="rounded-[1.7rem] border border-amber-200 bg-amber-50/95 px-5 py-4 text-sm text-slate-900 shadow-panel"
            key={entry.approval.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label="Approval needed" tone="warning" />
              <span className="font-semibold text-slate-900">{entry.approval.toolName}</span>
              <StatusPill label={entry.approval.riskLevel} tone={renderRiskTone(entry.approval.riskLevel)} />
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-700">{entry.approval.summary}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="rounded-full bg-[var(--hc-ink)] px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={isBusy}
                onClick={() => onDecision(entry.approval.id, "approve")}
                type="button"
              >
                {isBusy ? "Working..." : "Approve"}
              </button>
              <button
                className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed"
                disabled={isBusy}
                onClick={() => onDecision(entry.approval.id, "deny")}
                type="button"
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ChatApp({ providerName }: { providerName: string }) {
  const [history, setHistory] = useState<HistoryPayload>(defaultHistory);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadHistory() {
    const response = await fetch("/api/history");
    const payload = (await response.json()) as HistoryPayload & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? "Failed to load history.");
    }

    setHistory(payload);
  }

  useEffect(() => {
    void loadHistory().catch((loadError: Error) => {
      setError(loadError.message);
    });
  }, []);

  const entries = useMemo(() => {
    return [
      ...history.messages.map((item) => ({
        type: "message" as const,
        createdAt: item.createdAt,
        message: item,
      })),
      ...history.toolExecutions.map((item) => ({
        type: "tool" as const,
        createdAt: item.createdAt,
        toolExecution: item,
      })),
      ...history.pendingApprovals.map((item) => ({
        type: "approval" as const,
        createdAt: item.createdAt,
        approval: item,
      })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [history]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: trimmedMessage }),
      });

      const payload = (await response.json()) as ChatRouteResponse | { error: string };

      if (!response.ok || hasError(payload)) {
        throw new Error(hasError(payload) ? payload.error : "Failed to send message.");
      }

      setHistory({
        messages: payload.messages,
        toolExecutions: payload.toolExecutions,
        pendingApprovals: payload.pendingApprovals,
        usage: payload.usage,
      });
      setMessage("");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unexpected error.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDecision(requestId: string, decision: "approve" | "deny") {
    setActionLoadingId(requestId);
    setError(null);

    try {
      const response = await fetch("/api/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId, decision }),
      });

      const payload = (await response.json()) as ApproveRouteResponse | { error: string };

      if (!response.ok || hasError(payload)) {
        throw new Error(hasError(payload) ? payload.error : "Approval request failed.");
      }

      setHistory({
        messages: payload.messages,
        toolExecutions: payload.toolExecutions,
        pendingApprovals: payload.pendingApprovals,
        usage: payload.usage,
      });
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Unexpected error.");
    } finally {
      setActionLoadingId(null);
    }
  }

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="h-fit rounded-[2rem] border border-white/10 bg-[var(--hc-ink)] px-6 py-7 text-white shadow-panel lg:sticky lg:top-6">
          <p className="text-xs uppercase tracking-[0.34em] text-sky-300">HunterClaw</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Operator Desk</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            Local-first coding agent with compact activity tracking, approval boundaries, and live token accounting.
          </p>

          <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-slate-400">Active provider</p>
            <p className="mt-2 text-lg font-semibold text-white">{providerName}</p>
          </div>

          <div className="mt-6 space-y-4">
            <UsageCard prominent title="Conversation tokens" usage={history.usage.totals} />
            <UsageCard title="Last turn" usage={history.usage.lastTurn} />
          </div>

          <div className="mt-6 space-y-3 text-sm text-slate-200">
            <div className="rounded-[1.4rem] border border-white/10 bg-white/5 px-4 py-3">
              Tool activity is visible inline, but raw args and results stay in the backend backlog.
            </div>
            <div className="rounded-[1.4rem] border border-white/10 bg-white/5 px-4 py-3">
              The agent can inspect the repo on its own and will pause only for risky actions.
            </div>
            <div className="rounded-[1.4rem] border border-white/10 bg-white/5 px-4 py-3">
              Token totals include all model work tied to the turn, not just the final visible reply.
            </div>
          </div>
        </aside>

        <section className="flex min-h-[84vh] flex-col overflow-hidden rounded-[2rem] border border-[var(--hc-border)] bg-[var(--hc-surface)] shadow-panel">
          <div className="border-b border-[var(--hc-border)] px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--hc-muted)]">Live conversation</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--hc-text)]">Chat timeline</h2>
              </div>
              <div className="rounded-full border border-[var(--hc-border)] bg-[var(--hc-panel-soft)] px-4 py-2 text-sm text-[var(--hc-muted)]">
                {history.pendingApprovals.length > 0
                  ? `${history.pendingApprovals.length} approval${history.pendingApprovals.length === 1 ? "" : "s"} waiting`
                  : "No pending approvals"}
              </div>
            </div>
          </div>

          {error ? (
            <div className="border-b border-rose-200 bg-rose-50 px-6 py-4 text-sm text-rose-800">
              {error}
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto px-6 py-6">
            <Timeline entries={entries} onDecision={handleDecision} actionLoadingId={actionLoadingId} />
          </div>

          <form className="border-t border-[var(--hc-border)] bg-[var(--hc-surface)]/90 px-6 py-5 backdrop-blur" onSubmit={handleSubmit}>
            <label className="mb-3 block text-sm font-medium text-[var(--hc-text)]" htmlFor="message">
              Send a message
            </label>
            <textarea
              className="min-h-32 w-full rounded-[1.7rem] border border-[var(--hc-border-strong)] bg-[var(--hc-panel-soft)] px-5 py-4 text-sm leading-6 text-[var(--hc-text)] outline-none transition focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-100"
              disabled={isSubmitting}
              id="message"
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask the agent to inspect code, explain behavior, or make a change."
              value={message}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-[var(--hc-muted)]">
                Raw tool details are stored server-side; the timeline only shows concise activity summaries.
              </p>
              <button
                className="rounded-full bg-[var(--hc-ink)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
