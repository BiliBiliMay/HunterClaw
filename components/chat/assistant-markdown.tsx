"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { getSyntaxTheme, type ThemeMode } from "@/components/chat/syntax-theme";

const languagePattern = /language-([A-Za-z0-9_-]+)/;

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  children?: ReactNode;
  inline?: boolean;
};
type TableProps = ComponentPropsWithoutRef<"table"> & {
  children?: ReactNode;
};
type PreProps = ComponentPropsWithoutRef<"pre"> & {
  children?: ReactNode;
};

function MarkdownCode({
  children,
  className,
  inline,
  themeMode,
}: CodeProps & { themeMode: ThemeMode }) {
  const languageMatch = languagePattern.exec(className ?? "");
  const language = languageMatch?.[1] ?? "text";
  const content = String(children).replace(/\n$/, "");

  if (inline) {
    return <code className={className}>{children}</code>;
  }

  return (
    <SyntaxHighlighter
      customStyle={{
        background: "transparent",
        fontSize: "0.82rem",
        lineHeight: 1.65,
        margin: 0,
        padding: "1rem",
      }}
      language={language}
      showLineNumbers={content.includes("\n")}
      style={getSyntaxTheme(themeMode)}
      wrapLongLines
    >
      {content}
    </SyntaxHighlighter>
  );
}

export function AssistantMarkdown({
  content,
  themeMode,
}: {
  content: string;
  themeMode: ThemeMode;
}) {
  const components: Components = {
    code(props) {
      return <MarkdownCode {...props} themeMode={themeMode} />;
    },
    pre({ children }: PreProps) {
      return <>{children}</>;
    },
    table({ children }: TableProps) {
      return (
        <div className="hc-markdown-table">
          <table>{children}</table>
        </div>
      );
    },
  };

  return (
    <div className="hc-markdown">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
