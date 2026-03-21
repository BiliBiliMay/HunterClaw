import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  handleApprovalDecision,
  retryToolExecution,
  runAgentTurn,
} from "@/lib/agent/loop";
import {
  getHistoryPayload,
  listConversations,
} from "@/lib/agent/memory";
import type {
  ApprovalSummaryRecord,
  ApproveRouteResponse,
  ChatMessage,
  ChatRouteResponse,
  ConversationSummary,
  HistoryPayload,
  ToolTimelineRecord,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { getConfiguredProviderName } from "@/lib/llm/resolveProvider";
import { createId, toErrorMessage } from "@/lib/utils";

type SeenState = {
  messageIds: Set<string>;
  toolExecutionIds: Set<string>;
  approvalIds: Set<string>;
};

type CliOptions = {
  conversationId: string;
  listOnly: boolean;
  oneShotMessage: string | null;
};

type CliSessionState = {
  conversationId: string;
  seen: SeenState;
};

function loadLocalEnvFiles() {
  const processWithEnvLoader = process as typeof process & {
    loadEnvFile?: (file?: string) => void;
  };
  const envFiles = [".env.local", ".env"];

  for (const envFile of envFiles) {
    const absolutePath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    processWithEnvLoader.loadEnvFile?.(absolutePath);
  }
}

function createSeenState(): SeenState {
  return {
    messageIds: new Set(),
    toolExecutionIds: new Set(),
    approvalIds: new Set(),
  };
}

async function seedSeenState(seen: SeenState, conversationId: string) {
  const history = await getHistoryPayload(conversationId);

  for (const message of history.messages) {
    seen.messageIds.add(message.id);
  }

  for (const toolExecution of history.toolExecutions) {
    seen.toolExecutionIds.add(toolExecution.id);
  }

  for (const approval of history.pendingApprovals) {
    seen.approvalIds.add(approval.id);
  }
}

function printLine(text = "") {
  output.write(`${text}\n`);
}

function createConversationPlaceholder(conversationId: string): ConversationSummary {
  return {
    id: conversationId,
    title: conversationId === DEFAULT_CONVERSATION_ID ? "Default conversation" : "New conversation",
    preview: null,
    createdAt: null,
    lastActivityAt: null,
    messageCount: 0,
    pendingApprovalCount: 0,
  };
}

function ensureVisibleConversation(
  conversations: ConversationSummary[],
  conversationId: string,
) {
  if (conversations.some((conversation) => conversation.id === conversationId)) {
    return conversations;
  }

  return [createConversationPlaceholder(conversationId), ...conversations];
}

function formatConversationLabel(conversation: ConversationSummary) {
  const suffix = [
    `${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}`,
    `${conversation.pendingApprovalCount} pending approval${conversation.pendingApprovalCount === 1 ? "" : "s"}`,
  ].join(", ");

  return `${conversation.title} (${conversation.id}) - ${suffix}`;
}

async function printConversationList(activeConversationId: string) {
  const conversations = ensureVisibleConversation(await listConversations(), activeConversationId);

  printLine("Conversations:");
  for (const [index, conversation] of conversations.entries()) {
    const marker = conversation.id === activeConversationId ? "*" : " ";
    printLine(`${marker} ${index + 1}. ${formatConversationLabel(conversation)}`);
  }
  printLine();

  return conversations;
}

async function printConversationSummary(conversationId: string) {
  const conversations = ensureVisibleConversation(await listConversations(), conversationId);
  const conversation = conversations.find((item) => item.id === conversationId) ?? createConversationPlaceholder(conversationId);

  printLine(`Conversation: ${conversation.title}`);
  printLine(`ID: ${conversation.id}`);
  printLine(`State: ${conversation.messageCount} message${conversation.messageCount === 1 ? "" : "s"}, ${conversation.pendingApprovalCount} pending approval${conversation.pendingApprovalCount === 1 ? "" : "s"}`);
  printLine();
}

function printBanner(conversationId: string) {
  printLine("HunterClaw CLI");
  printLine(`Provider: ${getConfiguredProviderName()}`);
  printLine(`Conversation: ${conversationId}`);
  printLine("Type a message, or use /exit to quit.");
  printLine("Reads outside the project root are approval-gated. Shell stays project-scoped.");
  printLine("Commands: /help, /conversations, /new, /retry <toolExecutionId>, /switch <index|conversation-id>, /exit");
  printLine();
}

function renderMessage(message: ChatMessage) {
  const prefix = message.role === "user" ? "You" : message.kind === "error" ? "Assistant error" : "Assistant";
  printLine(`${prefix}: ${message.content}`);
}

function renderToolExecution(toolExecution: ToolTimelineRecord) {
  printLine(`Tool ${toolExecution.toolName} [${toolExecution.status}/${toolExecution.riskLevel}]`);
  printLine(`Summary: ${toolExecution.summary}`);
  if (toolExecution.error) {
    printLine(`Error: ${toolExecution.error}`);
  }
  if (toolExecution.retryable) {
    printLine(`Retry available: /retry ${toolExecution.id}`);
  }
  if (toolExecution.toolName === "codeTool" && toolExecution.details) {
    printLine(`Path: ${toolExecution.details.path}`);
    printLine(
      `Change: ${toolExecution.details.action} (+${toolExecution.details.stats.additions}/-${toolExecution.details.stats.deletions}, ${toolExecution.details.stats.bytesBefore}B -> ${toolExecution.details.stats.bytesAfter}B)`,
    );
    if (toolExecution.details.patch) {
      printLine("Patch:");
      printLine(toolExecution.details.patch);
    }
    if (toolExecution.details.truncated) {
      printLine("(preview truncated)");
    }
  }
}

function renderApproval(approval: ApprovalSummaryRecord) {
  printLine(`Approval required for ${approval.toolName} [${approval.riskLevel}]`);
  printLine(`Summary: ${approval.summary}`);
  if (approval.toolName === "codeTool" && approval.details) {
    printLine(`Path: ${approval.details.path}`);
    printLine(
      `Change: ${approval.details.action} (+${approval.details.stats.additions}/-${approval.details.stats.deletions}, ${approval.details.stats.bytesBefore}B -> ${approval.details.stats.bytesAfter}B)`,
    );
    if (approval.details.patch) {
      printLine("Patch:");
      printLine(approval.details.patch);
    }
    if (approval.details.truncated) {
      printLine("(preview truncated)");
    }
  }
}

function renderNewHistory(history: HistoryPayload, seen: SeenState) {
  for (const message of history.messages) {
    if (seen.messageIds.has(message.id)) {
      continue;
    }

    seen.messageIds.add(message.id);
    if (message.role === "assistant") {
      renderMessage(message);
      printLine();
    }
  }

  for (const toolExecution of history.toolExecutions) {
    if (seen.toolExecutionIds.has(toolExecution.id)) {
      continue;
    }

    seen.toolExecutionIds.add(toolExecution.id);
    renderToolExecution(toolExecution);
    printLine();
  }

  for (const approval of history.pendingApprovals) {
    if (seen.approvalIds.has(approval.id)) {
      continue;
    }

    seen.approvalIds.add(approval.id);
    renderApproval(approval);
    printLine();
  }
}

async function resolveApproval(
  rl: ReturnType<typeof createInterface>,
  response: ChatRouteResponse,
  seen: SeenState,
) {
  const pendingApproval = response.pendingApproval;

  if (!pendingApproval) {
    return;
  }

  while (true) {
    const rawDecision = await rl.question("Approve? [y/n]: ");
    const normalized = rawDecision.trim().toLowerCase();

    if (normalized !== "y" && normalized !== "yes" && normalized !== "n" && normalized !== "no") {
      printLine("Please answer y or n.");
      continue;
    }

    try {
      const approvalResponse: ApproveRouteResponse = await handleApprovalDecision({
        requestId: pendingApproval.id,
        decision: normalized.startsWith("y") ? "approve" : "deny",
      });

      renderNewHistory(approvalResponse, seen);
    } catch (error) {
      printLine(`Assistant error: ${toErrorMessage(error)}`);
      printLine();
    }

    return;
  }
}

async function switchConversation(
  state: CliSessionState,
  conversationId: string,
) {
  state.conversationId = conversationId;
  state.seen = createSeenState();
  await seedSeenState(state.seen, conversationId);
  await printConversationSummary(conversationId);
}

async function retryExecution(
  toolExecutionId: string,
  seen: SeenState,
) {
  const trimmedExecutionId = toolExecutionId.trim();

  if (!trimmedExecutionId) {
    printLine("Usage: /retry <toolExecutionId>");
    printLine();
    return;
  }

  try {
    const response = await retryToolExecution({
      toolExecutionId: trimmedExecutionId,
    });

    renderNewHistory(response, seen);
  } catch (error) {
    printLine(`Assistant error: ${toErrorMessage(error)}`);
    printLine();
  }
}

function resolveConversationSelection(
  rawValue: string,
  conversations: ConversationSummary[],
) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const index = Number.parseInt(trimmed, 10);
  if (Number.isFinite(index) && String(index) === trimmed) {
    return conversations[index - 1]?.id ?? null;
  }

  return trimmed;
}

function parseCliOptions(argv: string[]): CliOptions {
  let conversationId = DEFAULT_CONVERSATION_ID;
  let oneShotMessageParts: string[] = [];
  let listOnly = false;
  let startFresh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      printLine("Usage: npm run agent:cli -- [--conversation <id> | --new] [--list] [message]");
      printLine();
      printLine("Examples:");
      printLine('npm run agent:cli -- --conversation bugfix');
      printLine('npm run agent:cli -- --new "inspect the auth flow"');
      process.exit(0);
    }

    if (arg === "--list") {
      listOnly = true;
      continue;
    }

    if (arg === "--new") {
      startFresh = true;
      continue;
    }

    if (arg === "--conversation") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("Missing value for --conversation.");
      }

      conversationId = nextValue.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("--conversation=")) {
      conversationId = arg.slice("--conversation=".length).trim();
      continue;
    }

    oneShotMessageParts = argv.slice(index);
    break;
  }

  if (startFresh && conversationId !== DEFAULT_CONVERSATION_ID) {
    throw new Error("Use either --conversation or --new, not both.");
  }

  if (startFresh) {
    conversationId = createId("conv");
  }

  if (!conversationId) {
    throw new Error("Conversation id cannot be empty.");
  }

  const oneShotMessage = oneShotMessageParts.join(" ").trim() || null;

  return {
    conversationId,
    listOnly,
    oneShotMessage,
  };
}

async function runOneShot(message: string, conversationId: string) {
  const seen = createSeenState();
  await seedSeenState(seen, conversationId);

  try {
    const response = await runAgentTurn({ message, conversationId });
    renderNewHistory(response, seen);

    if (response.status === "approval_required") {
      printLine("One-shot mode reached an approval boundary. Run the interactive CLI to approve or deny it.");
    } else if (response.status === "retry_required") {
      printLine("One-shot mode reached a retry boundary. Run the interactive CLI and use /retry <toolExecutionId>.");
    }
  } catch (error) {
    printLine(`Assistant error: ${toErrorMessage(error)}`);
  }
}

async function runInteractive(initialConversationId: string) {
  const rl = createInterface({ input, output });
  const state: CliSessionState = {
    conversationId: initialConversationId,
    seen: createSeenState(),
  };

  await seedSeenState(state.seen, state.conversationId);
  printBanner(state.conversationId);
  await printConversationSummary(state.conversationId);

  try {
    while (true) {
      const message = (await rl.question("> ")).trim();

      if (!message) {
        continue;
      }

      if (message === "/exit" || message === "/quit") {
        break;
      }

      if (message === "/help") {
        printLine("Commands:");
        printLine("/help  Show this help");
        printLine("/conversations  List available conversations");
        printLine("/new  Start a fresh conversation");
        printLine("/retry <toolExecutionId>  Retry a failed tool execution");
        printLine("/switch <index|conversation-id>  Switch threads");
        printLine("/exit  Quit the CLI");
        printLine();
        continue;
      }

      if (message === "/conversations") {
        await printConversationList(state.conversationId);
        continue;
      }

      if (message === "/new") {
        await switchConversation(state, createId("conv"));
        continue;
      }

      if (message.startsWith("/switch")) {
        const rawTarget = message.slice("/switch".length).trim();
        const conversations = await printConversationList(state.conversationId);
        const conversationId = resolveConversationSelection(rawTarget, conversations);

        if (!conversationId) {
          printLine("Usage: /switch <index|conversation-id>");
          printLine();
          continue;
        }

        await switchConversation(state, conversationId);
        continue;
      }

      if (message.startsWith("/retry")) {
        await retryExecution(message.slice("/retry".length), state.seen);
        continue;
      }

      try {
        const response = await runAgentTurn({ message, conversationId: state.conversationId });
        renderNewHistory(response, state.seen);

        if (response.status === "approval_required") {
          await resolveApproval(rl, response, state.seen);
        }
      } catch (error) {
        printLine(`Assistant error: ${toErrorMessage(error)}`);
        printLine();
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  loadLocalEnvFiles();
  const options = parseCliOptions(process.argv.slice(2));

  if (options.listOnly && !options.oneShotMessage) {
    await printConversationList(options.conversationId);
    return;
  }

  if (options.oneShotMessage) {
    await runOneShot(options.oneShotMessage, options.conversationId);
    return;
  }

  await runInteractive(options.conversationId);
}

void main().catch((error) => {
  printLine(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
