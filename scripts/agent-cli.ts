import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  handleApprovalDecision,
  runAgentTurn,
} from "@/lib/agent/loop";
import { getHistoryPayload } from "@/lib/agent/memory";
import type {
  ApprovalSummaryRecord,
  ApproveRouteResponse,
  ChatMessage,
  ChatRouteResponse,
  HistoryPayload,
  ToolTimelineRecord,
} from "@/lib/agent/types";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { getConfiguredProviderName } from "@/lib/llm/resolveProvider";
import { toErrorMessage } from "@/lib/utils";

type SeenState = {
  messageIds: Set<string>;
  toolExecutionIds: Set<string>;
  approvalIds: Set<string>;
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

async function seedSeenState(seen: SeenState) {
  const history = await getHistoryPayload(DEFAULT_CONVERSATION_ID);

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

function printBanner() {
  printLine("HunterClaw CLI");
  printLine(`Provider: ${getConfiguredProviderName()}`);
  printLine(`Conversation: ${DEFAULT_CONVERSATION_ID}`);
  printLine("Type a message, or use /exit to quit.");
  printLine("Reads outside the project root are approval-gated. Shell stays project-scoped.");
  printLine("Examples: inspect this repo and explain the architecture; find the bug in the agent loop; make a change and summarize it");
  printLine();
}

function renderMessage(message: ChatMessage) {
  const prefix = message.role === "user" ? "You" : message.kind === "error" ? "Assistant error" : "Assistant";
  printLine(`${prefix}: ${message.content}`);
}

function renderToolExecution(toolExecution: ToolTimelineRecord) {
  printLine(
    `Tool ${toolExecution.toolName} [${toolExecution.status}/${toolExecution.riskLevel}]`,
  );
  printLine(`Summary: ${toolExecution.summary}`);
}

function renderApproval(approval: ApprovalSummaryRecord) {
  printLine(`Approval required for ${approval.toolName} [${approval.riskLevel}]`);
  printLine(`Summary: ${approval.summary}`);
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

async function runOneShot(message: string) {
  const seen = createSeenState();
  await seedSeenState(seen);
  try {
    const response = await runAgentTurn({ message });
    renderNewHistory(response, seen);

    if (response.status === "approval_required") {
      printLine("One-shot mode reached an approval boundary. Run the interactive CLI to approve or deny it.");
    }
  } catch (error) {
    printLine(`Assistant error: ${toErrorMessage(error)}`);
  }
}

async function runInteractive() {
  const rl = createInterface({ input, output });
  const seen = createSeenState();
  await seedSeenState(seen);

  printBanner();

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
        printLine("/exit  Quit the CLI");
        printLine();
        continue;
      }

      try {
        const response = await runAgentTurn({ message });
        renderNewHistory(response, seen);

        if (response.status === "approval_required") {
          await resolveApproval(rl, response, seen);
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
  const oneShotMessage = process.argv.slice(2).join(" ").trim();

  if (oneShotMessage) {
    await runOneShot(oneShotMessage);
    return;
  }

  await runInteractive();
}

void main().catch((error) => {
  printLine(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
