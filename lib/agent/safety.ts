import type { RiskLevel } from "@/lib/agent/types";
import type { ApprovalPreferenceKey } from "@/lib/agent/approvalPreferences";
import { getApprovalPreference } from "@/lib/agent/memory";
import { resolveCodeToolPath } from "@/lib/tools/codeTool";
import { resolveFilePath } from "@/lib/tools/fileTool";
import { resolveShellToolCwd } from "@/lib/tools/shellTool";

type SafetyEvaluation = {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
};

export async function evaluateToolSafety(
  toolName: string,
  args: unknown,
  riskLevel: RiskLevel,
): Promise<SafetyEvaluation> {
  let requiresApproval = riskLevel !== "low";

  if (requiresApproval) {
    const approvalPreferenceKey = getApprovalPreferenceKey(toolName, args);
    const preferenceValue = approvalPreferenceKey
      ? await getApprovalPreference(approvalPreferenceKey)
      : null;

    if (preferenceValue === true) {
      requiresApproval = false;
    } else if (
      preferenceValue === null &&
      approvalPreferenceKey === "approval.file.project.write" &&
      process.env.AUTO_APPROVE_FILE_WRITES === "true"
    ) {
      requiresApproval = false;
    }
  }

  return {
    riskLevel,
    requiresApproval,
  };
}

function getApprovalPreferenceKey(
  toolName: string,
  args: unknown,
): ApprovalPreferenceKey | null {
  if (toolName === "fileTool" && isFileToolArgs(args)) {
    const { scope } = resolveFilePath(args.path);

    if (scope === "host" && args.action === "readFile") {
      return "approval.file.host.read";
    }

    if (scope === "host" && args.action === "listDirectory") {
      return "approval.file.host.list";
    }

    if (args.action === "writeFile") {
      return scope === "project"
        ? "approval.file.project.write"
        : "approval.file.host.write";
    }

    return null;
  }

  if (toolName === "codeTool" && isCodeToolArgs(args)) {
    const { scope } = resolveCodeToolPath(args);

    if (args.action === "createFile") {
      return scope === "project"
        ? "approval.code.project.create"
        : "approval.code.host.create";
    }

    return scope === "project"
      ? "approval.code.project.patch"
      : "approval.code.host.patch";
  }

  if (toolName === "shellTool" && isShellToolArgs(args)) {
    return resolveShellToolCwd(args.cwd).scope === "host"
      ? "approval.shell.host.cwd"
      : null;
  }

  if (toolName === "browserTool" && isInteractiveBrowserAction(args)) {
    return args.action === "click"
      ? "approval.browser.click"
      : "approval.browser.type";
  }

  return null;
}

function isFileToolArgs(
  args: unknown,
): args is {
  action: "readFile" | "writeFile" | "listDirectory";
  path: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    "path" in args &&
    typeof args.action === "string" &&
    typeof args.path === "string"
  );
}

function isCodeToolArgs(
  args: unknown,
): args is
  | {
      action: "createFile";
      path: string;
      content: string;
    }
  | {
      action: "applyPatch";
      patch: string;
    } {
  return (
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    typeof args.action === "string" &&
    ((args.action === "createFile" && "path" in args && typeof args.path === "string")
      || (args.action === "applyPatch" && "patch" in args && typeof args.patch === "string"))
  );
}

function isShellToolArgs(
  args: unknown,
): args is {
  command: string;
  cwd?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "command" in args &&
    typeof args.command === "string" &&
    (!("cwd" in args) || args.cwd === undefined || typeof args.cwd === "string")
  );
}

function isInteractiveBrowserAction(
  args: unknown,
): args is {
  action: "click" | "type";
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    (args.action === "click" || args.action === "type")
  );
}
