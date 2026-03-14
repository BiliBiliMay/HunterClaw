"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import type {
  ApprovalRequestRecord,
  ApproveRouteResponse,
  ChatMessage,
  ChatRouteResponse,
  HistoryPayload,
  ToolExecutionRecord,
} from "@/lib/agent/types";

type TimelineEntry =
  | { type: "message"; createdAt: string; message: ChatMessage }
  | { type: "tool"; createdAt: string; toolExecution: ToolExecutionRecord }
  | { type: "approval"; createdAt: string; approval: ApprovalRequestRecord };

const defaultHistory: HistoryPayload = {
  messages: [],
  toolExecutions: [],
  pendingApprovals: [],
};

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function hasError(payload: { error?: string }): payload is { error: string } {
  return Boolean(payload.error);
}

function Timeline({ entries, onDecision, actionLoadingId }: {
  entries: TimelineEntry[];
  onDecision: (requestId: string, decision: "approve" | "deny") => Promise<void>;
  actionLoadingId: string | null;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-white/70 p-8 text-sm text-slate-600 shadow-panel">
        Start with a message like <code className="rounded bg-slate-100 px-1 py-0.5">list files</code> or{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5">read file welcome.txt</code>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {entries.map((entry) => {
        if (entry.type === "message") {
          const isUser = entry.message.role === "user";

          return (
            <div
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
              key={entry.message.id}
            >
              <div
                className={`max-w-3xl rounded-3xl px-4 py-3 shadow-panel ${
                  isUser
                    ? "bg-slate-900 text-white"
                    : entry.message.kind === "error"
                      ? "border border-rose-200 bg-rose-50 text-rose-900"
                      : "border border-white/70 bg-white/80 text-slate-900"
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
              className="rounded-3xl border border-sky-200 bg-sky-50/90 p-4 text-sm text-slate-900 shadow-panel"
              key={entry.toolExecution.id}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-sky-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white">
                  Tool
                </span>
                <span className="font-semibold">{entry.toolExecution.toolName}</span>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                  {entry.toolExecution.status}
                </span>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                  {entry.toolExecution.riskLevel}
                </span>
              </div>
              <pre className="overflow-x-auto rounded-2xl bg-slate-950/95 p-3 text-xs text-sky-100">
                {prettyJson(entry.toolExecution.args)}
              </pre>
              {entry.toolExecution.error ? (
                <p className="mt-3 whitespace-pre-wrap text-rose-700">{entry.toolExecution.error}</p>
              ) : entry.toolExecution.result ? (
                <pre className="mt-3 overflow-x-auto rounded-2xl bg-white p-3 text-xs text-slate-700">
                  {prettyJson(entry.toolExecution.result)}
                </pre>
              ) : null}
            </div>
          );
        }

        const isBusy = actionLoadingId === entry.approval.id;

        return (
          <div
            className="rounded-3xl border border-amber-200 bg-amber-50/95 p-4 text-sm text-slate-900 shadow-panel"
            key={entry.approval.id}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-950">
                Approval needed
              </span>
              <span className="font-semibold">{entry.approval.toolName}</span>
              <span className="rounded-full bg-white px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
                {entry.approval.riskLevel}
              </span>
            </div>
            <p className="mb-3 whitespace-pre-wrap text-slate-700">{entry.approval.reason}</p>
            <pre className="overflow-x-auto rounded-2xl bg-white p-3 text-xs text-slate-700">
              {prettyJson(entry.approval.args)}
            </pre>
            <div className="mt-4 flex gap-3">
              <button
                className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
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

export function ChatApp() {
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

      const payload = (await response.json()) as
        | ChatRouteResponse
        | { error: string };

      if (!response.ok || hasError(payload)) {
        throw new Error(hasError(payload) ? payload.error : "Failed to send message.");
      }

      setHistory({
        messages: payload.messages,
        toolExecutions: payload.toolExecutions,
        pendingApprovals: payload.pendingApprovals,
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

      const payload = (await response.json()) as
        | ApproveRouteResponse
        | { error: string };

      if (!response.ok || hasError(payload)) {
        throw new Error(hasError(payload) ? payload.error : "Approval request failed.");
      }

      setHistory({
        messages: payload.messages,
        toolExecutions: payload.toolExecutions,
        pendingApprovals: payload.pendingApprovals,
      });
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Unexpected error.");
    } finally {
      setActionLoadingId(null);
    }
  }

  return (
    <main className="min-h-screen px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="rounded-[2rem] border border-white/70 bg-slate-950 px-6 py-8 text-white shadow-panel">
          <p className="text-xs uppercase tracking-[0.32em] text-sky-300">HunterClaw</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Local-first coding agent MVP</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            This MVP stays local. It stores chat history in SQLite, runs a deterministic provider,
            and only works inside <code className="rounded bg-white/10 px-1 py-0.5">data/workspace</code>.
          </p>
          <div className="mt-8 space-y-3 text-sm text-slate-200">
            <p className="rounded-2xl bg-white/5 px-4 py-3">
              <span className="font-semibold text-white">Try:</span> list files
            </p>
            <p className="rounded-2xl bg-white/5 px-4 py-3">
              <span className="font-semibold text-white">Try:</span> read file welcome.txt
            </p>
            <p className="rounded-2xl bg-white/5 px-4 py-3">
              <span className="font-semibold text-white">Try:</span> write file notes.txt with content hello from HunterClaw
            </p>
          </div>
        </section>

        <section className="flex min-h-[80vh] flex-col rounded-[2rem] border border-white/80 bg-white/75 p-4 shadow-panel backdrop-blur">
          <div className="border-b border-slate-200 px-4 py-4">
            <h2 className="text-lg font-semibold text-slate-900">Chat</h2>
            <p className="mt-1 text-sm text-slate-500">
              Messages, tool activity, and approvals all appear inline for easier debugging.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-6">
            <Timeline entries={entries} onDecision={handleDecision} actionLoadingId={actionLoadingId} />
          </div>

          <form className="border-t border-slate-200 px-4 py-4" onSubmit={handleSubmit}>
            <label className="mb-3 block text-sm font-medium text-slate-700" htmlFor="message">
              Send a message
            </label>
            <textarea
              className="min-h-28 w-full rounded-3xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-100"
              disabled={isSubmitting}
              id="message"
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask the agent to inspect files, run a safe shell command, or browse a page."
              value={message}
            />
            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-sm text-slate-500">
                Risky actions pause for approval. Dangerous shell commands are blocked.
              </p>
              <button
                className="rounded-full bg-sky-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-sky-300"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Sending..." : "Send"}
              </button>
            </div>
            {error ? (
              <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </p>
            ) : null}
          </form>
        </section>
      </div>
    </main>
  );
}
