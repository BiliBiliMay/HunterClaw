"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";

import { getSyntaxTheme, type ThemeMode } from "@/components/chat/syntax-theme";
import type { ToolPresentationDetails } from "@/lib/agent/types";

function formatActionLabel(action: ToolPresentationDetails["action"]) {
  return action === "createFile" ? "Create file" : "Apply patch";
}

function PreviewPane({
  content,
  emptyLabel,
  label,
  language,
  themeMode,
}: {
  content: string | null;
  emptyLabel: string;
  label: string;
  language: string;
  themeMode: ThemeMode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--hc-border)] bg-[var(--hc-panel-elevated)]">
      <div className="border-b border-[var(--hc-border)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--hc-muted)]">
        {label}
      </div>
      {content ? (
        <SyntaxHighlighter
          customStyle={{
            background: "transparent",
            fontSize: "0.8rem",
            lineHeight: 1.6,
            margin: 0,
            padding: "1rem",
          }}
          language={language}
          showLineNumbers
          style={getSyntaxTheme(themeMode)}
          wrapLongLines
        >
          {content}
        </SyntaxHighlighter>
      ) : (
        <div className="px-4 py-6 text-sm text-[var(--hc-muted)]">{emptyLabel}</div>
      )}
    </div>
  );
}

export function CodeChangePreview({
  defaultOpen = false,
  details,
  themeMode,
}: {
  defaultOpen?: boolean;
  details: ToolPresentationDetails;
  themeMode: ThemeMode;
}) {
  return (
    <details className="mt-4 overflow-hidden rounded-[1.25rem] border border-[var(--hc-border)] bg-[var(--hc-panel)]" open={defaultOpen}>
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-[var(--hc-text)] marker:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <span>Review changes</span>
          <span className="rounded-full border border-[var(--hc-border)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--hc-muted)]">
            {formatActionLabel(details.action)}
          </span>
          <span className="rounded-full border border-[var(--hc-border)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--hc-muted)]">
            +{details.stats.additions}/-{details.stats.deletions}
          </span>
          {details.truncated ? (
            <span className="rounded-full border border-[var(--hc-warning-border)] bg-[var(--hc-warning-badge-bg)] px-2 py-1 text-[11px] uppercase tracking-[0.14em] text-[var(--hc-warning-badge-text)]">
              Truncated
            </span>
          ) : null}
        </div>
      </summary>

      <div className="border-t border-[var(--hc-border)] px-4 py-4">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-[var(--hc-muted)]">
          <span className="font-medium text-[var(--hc-text)]">{details.path}</span>
          <span>{details.language}</span>
          <span>{details.stats.bytesBefore.toLocaleString()}B before</span>
          <span>{details.stats.bytesAfter.toLocaleString()}B after</span>
        </div>

        {details.patch ? (
          <div className="mb-4">
            <PreviewPane
              content={details.patch}
              emptyLabel="No patch preview available."
              label="Patch"
              language="diff"
              themeMode={themeMode}
            />
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <PreviewPane
            content={details.beforeSnippet}
            emptyLabel="No prior file content."
            label="Before"
            language={details.language}
            themeMode={themeMode}
          />
          <PreviewPane
            content={details.afterSnippet}
            emptyLabel="No resulting file content."
            label="After"
            language={details.language}
            themeMode={themeMode}
          />
        </div>
      </div>
    </details>
  );
}
