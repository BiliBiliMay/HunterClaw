import type { RiskLevel } from "@/lib/agent/types";
import { getPreference } from "@/lib/agent/memory";

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

  if (toolName === "fileTool" && isWriteFileAction(args) && riskLevel === "medium") {
    const preferenceValue = await getPreference("autoApproveFileWrites");
    const autoApproveFromEnv = process.env.AUTO_APPROVE_FILE_WRITES === "true";

    if (preferenceValue === "true" || autoApproveFromEnv) {
      requiresApproval = false;
    }
  }

  if (toolName === "browserTool" && isInteractiveBrowserAction(args)) {
    requiresApproval = true;
  }

  return {
    riskLevel,
    requiresApproval,
  };
}

function isWriteFileAction(args: unknown) {
  return (
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    args.action === "writeFile"
  );
}

function isInteractiveBrowserAction(args: unknown) {
  return (
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    (args.action === "click" || args.action === "type")
  );
}
