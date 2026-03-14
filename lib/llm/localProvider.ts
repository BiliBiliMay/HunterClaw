import type {
  JsonValue,
  ProviderContext,
  ProviderDecision,
  ToolResult,
} from "@/lib/agent/types";
import type { AgentProvider, SummaryContext } from "@/lib/llm/provider";

import { FALLBACK_TEXT, HELP_TEXT } from "@/lib/llm/prompts";
import { stripWrappingQuotes } from "@/lib/utils";

function parseListDirectory(message: string): ProviderDecision | null {
  const match = /^(?:list|show)\s+(?:files|directory|dir)(?:\s+(?:in\s+)?(.+))?$/i.exec(message);

  if (!match) {
    return null;
  }

  return {
    type: "tool_call",
    toolName: "fileTool",
    args: {
      action: "listDirectory",
      path: stripWrappingQuotes(match[1] ?? "."),
    },
    reason: "Listing workspace files.",
  };
}

function parseReadFile(message: string): ProviderDecision | null {
  const match = /^(?:read|show|open)\s+file\s+(.+)$/i.exec(message);

  if (!match) {
    return null;
  }

  return {
    type: "tool_call",
    toolName: "fileTool",
    args: {
      action: "readFile",
      path: stripWrappingQuotes(match[1]),
    },
    reason: "Reading a file from the local workspace.",
  };
}

function parseWriteFile(message: string): ProviderDecision | null {
  const withContentMatch = /^write\s+file\s+(.+?)\s+with\s+content\s+([\s\S]+)$/i.exec(message);
  if (withContentMatch) {
    return {
      type: "tool_call",
      toolName: "fileTool",
      args: {
        action: "writeFile",
        path: stripWrappingQuotes(withContentMatch[1]),
        content: withContentMatch[2],
      },
      reason: "Writing a file inside the local workspace.",
    };
  }

  const multilineMatch = /^write\s+file\s+([^\n]+)\n([\s\S]+)$/i.exec(message);
  if (multilineMatch) {
    return {
      type: "tool_call",
      toolName: "fileTool",
      args: {
        action: "writeFile",
        path: stripWrappingQuotes(multilineMatch[1]),
        content: multilineMatch[2],
      },
      reason: "Writing a file inside the local workspace.",
    };
  }

  return null;
}

function parseShell(message: string): ProviderDecision | null {
  const match = /^(?:run|shell)\s+([\s\S]+)$/i.exec(message);

  if (!match) {
    return null;
  }

  return {
    type: "tool_call",
    toolName: "shellTool",
    args: {
      command: match[1].trim(),
    },
    reason: "Running a safe shell command in the workspace.",
  };
}

function parseBrowser(message: string): ProviderDecision | null {
  const openMatch = /^(?:open|browse|go to)\s+(https?:\/\/\S+)$/i.exec(message);
  if (openMatch) {
    return {
      type: "tool_call",
      toolName: "browserTool",
      args: {
        action: "openPage",
        url: openMatch[1],
      },
      reason: "Opening a web page in the local browser session.",
    };
  }

  if (/^(?:extract|get|read)\s+(?:the\s+)?title(?:\s+from\s+(?:the\s+)?current page)?$/i.test(message)) {
    return {
      type: "tool_call",
      toolName: "browserTool",
      args: {
        action: "extractTitle",
      },
      reason: "Extracting the title from the current browser page.",
    };
  }

  if (/^(?:extract|get|read)\s+(?:the\s+)?(?:visible\s+)?text(?:\s+from\s+(?:the\s+)?current page)?$/i.test(message)) {
    return {
      type: "tool_call",
      toolName: "browserTool",
      args: {
        action: "extractVisibleText",
      },
      reason: "Extracting visible text from the current browser page.",
    };
  }

  const clickMatch = /^click\s+(.+)$/i.exec(message);
  if (clickMatch) {
    return {
      type: "tool_call",
      toolName: "browserTool",
      args: {
        action: "click",
        selector: clickMatch[1].trim(),
      },
      reason: "Clicking an element in the current browser page.",
    };
  }

  const typeMatch = /^type\s+(.+?)\s+with\s+([\s\S]+)$/i.exec(message);
  if (typeMatch) {
    return {
      type: "tool_call",
      toolName: "browserTool",
      args: {
        action: "type",
        selector: typeMatch[1].trim(),
        text: typeMatch[2],
      },
      reason: "Typing into an element in the current browser page.",
    };
  }

  return null;
}

function formatListOutput(output: JsonValue | null) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return "The tool completed, but there was no structured result to show.";
  }

  const asRecord = output as { [key: string]: JsonValue };

  if (Array.isArray(asRecord.entries)) {
    const lines = (asRecord.entries as JsonValue[])
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return "- unknown";
        }

        const item = entry as { [key: string]: JsonValue };
        return `- ${item.name} (${item.type})`;
      })
      .join("\n");

    return [`Listed ${String(asRecord.path ?? ".")}:`, lines || "- empty directory"].join("\n");
  }

  return JSON.stringify(output, null, 2);
}

function formatToolResult(result: ToolResult) {
  if (result.status !== "success") {
    const prefix = result.status === "blocked" ? "I blocked that action." : "The tool failed.";
    return `${prefix}\n\n${result.error ?? "No extra error details were returned."}`;
  }

  if (result.toolName === "fileTool") {
    const output = result.output as { action?: string; path?: string; content?: string } | null;

    if (output?.action === "listDirectory") {
      return formatListOutput(result.output);
    }

    if (output?.action === "readFile") {
      return [`Read ${output.path ?? "file"}:`, "", output.content ?? ""].join("\n");
    }

    if (output?.action === "writeFile") {
      return `Wrote ${output.path ?? "the file"} successfully.`;
    }
  }

  if (result.toolName === "shellTool") {
    const output = result.output as { command?: string; stdout?: string; stderr?: string } | null;
    const lines = [
      `Command completed: ${output?.command ?? "unknown command"}`,
      "",
      "stdout:",
      output?.stdout?.trim() || "(empty)",
    ];

    if (output?.stderr?.trim()) {
      lines.push("", "stderr:", output.stderr.trim());
    }

    return lines.join("\n");
  }

  if (result.toolName === "browserTool") {
    const output = result.output as {
      action?: string;
      title?: string;
      url?: string;
      text?: string;
      selector?: string;
    } | null;

    if (output?.action === "openPage") {
      return `Opened ${output.url ?? "the page"}.\n\nTitle: ${output.title ?? "(no title found)"}`;
    }

    if (output?.action === "extractTitle") {
      return `Current page title: ${output?.title ?? "(no title found)"}`;
    }

    if (output?.action === "extractVisibleText") {
      return [`Visible page text:`, "", output?.text ?? ""].join("\n");
    }

    if (output?.action === "click") {
      return `Clicked ${output.selector ?? "the requested selector"}.`;
    }

    if (output?.action === "type") {
      return `Typed into ${output.selector ?? "the requested selector"}.`;
    }
  }

  return JSON.stringify(result.output, null, 2);
}

async function summarizeConversation({ previousSummary, messages }: SummaryContext) {
  const summaryLines: string[] = [];

  if (previousSummary) {
    summaryLines.push(`Previous summary: ${previousSummary}`);
  }

  for (const message of messages) {
    const snippet = message.content.replace(/\s+/g, " ").trim().slice(0, 180);
    summaryLines.push(`${message.role}: ${snippet}`);
  }

  return summaryLines.join("\n");
}

export const localProvider: AgentProvider = {
  name: "local",
  async generateResponse(context: ProviderContext) {
    if (context.lastToolResult) {
      return {
        type: "message",
        content: formatToolResult(context.lastToolResult),
      };
    }

    const message = context.latestUserMessage.trim();
    if (!message) {
      return {
        type: "message",
        content: HELP_TEXT.join("\n"),
      };
    }

    if (/^(?:help|what can you do|capabilities)$/i.test(message)) {
      return {
        type: "message",
        content: HELP_TEXT.join("\n"),
      };
    }

    return (
      parseWriteFile(message) ??
      parseReadFile(message) ??
      parseListDirectory(message) ??
      parseShell(message) ??
      parseBrowser(message) ?? {
        type: "message",
        content: FALLBACK_TEXT,
      }
    );
  },
  async plan(context: ProviderContext) {
    return this.generateResponse(context);
  },
  async summarize(context: SummaryContext) {
    return summarizeConversation(context);
  },
};

