import type {
  ApprovalRequestRecord,
  ApprovalSummaryRecord,
  ToolExecutionRecord,
  ToolPresentationDetails,
  ToolTimelineRecord,
} from "@/lib/agent/types";

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function summarizeToolCall(
  toolName: string,
  args: unknown,
  presentation?: ToolPresentationDetails | null,
) {
  const parsedArgs = asRecord(args);

  if (toolName === "codeTool") {
    const action = asString(parsedArgs?.action) ?? presentation?.action ?? null;
    const targetPath = asString(parsedArgs?.path) ?? presentation?.path ?? null;

    if (action === "createFile" && targetPath) {
      return `Creating ${targetPath}`;
    }

    if (action === "applyPatch" && targetPath) {
      return `Patching ${targetPath}`;
    }

    return "Applying a code change";
  }

  if (toolName === "fileTool") {
    const action = asString(parsedArgs?.action);
    const targetPath = asString(parsedArgs?.path);

    if (action === "readFile" && targetPath) {
      return `Reading ${targetPath}`;
    }

    if (action === "writeFile" && targetPath) {
      return `Writing ${targetPath}`;
    }

    if (action === "listDirectory" && targetPath) {
      return `Listing ${targetPath}`;
    }

    return "Using a local file tool";
  }

  if (toolName === "shellTool") {
    const command = asString(parsedArgs?.command);
    const cwd = asString(parsedArgs?.cwd);

    if (command && cwd) {
      return `Running ${command} in ${cwd}`;
    }

    return command ? `Running ${command}` : "Running a shell command in the configured root";
  }

  if (toolName === "browserTool") {
    const action = asString(parsedArgs?.action);
    const url = asString(parsedArgs?.url);
    const selector = asString(parsedArgs?.selector);

    if (action === "openPage" && url) {
      return `Opening ${url}`;
    }

    if (action === "extractTitle") {
      return "Extracting the current page title";
    }

    if (action === "extractVisibleText") {
      return "Extracting visible text from the current page";
    }

    if (action === "click" && selector) {
      return `Clicking ${selector}`;
    }

    if (action === "type" && selector) {
      return `Typing into ${selector}`;
    }

    return "Using a browser action";
  }

  return `Using ${toolName}`;
}

export function toToolTimelineRecord(record: ToolExecutionRecord): ToolTimelineRecord {
  return {
    id: record.id,
    toolName: record.toolName,
    agentRole: record.agentRole,
    riskLevel: record.riskLevel,
    status: record.status,
    summary: summarizeToolCall(record.toolName, record.args, record.presentation),
    details: record.presentation,
    error: record.error,
    retryable: record.retryable,
    retryOfExecutionId: record.retryOfExecutionId,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
}

export function toApprovalSummaryRecord(record: ApprovalRequestRecord): ApprovalSummaryRecord {
  return {
    id: record.id,
    toolName: record.toolName,
    riskLevel: record.riskLevel,
    summary: summarizeToolCall(record.toolName, record.args, record.presentation),
    details: record.presentation,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
  };
}
