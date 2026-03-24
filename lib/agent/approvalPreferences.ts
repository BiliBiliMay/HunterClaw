export const approvalPreferenceDefinitions = [
  {
    key: "approval.file.host.read",
    group: "Files",
    title: "Off-root file reads",
    description: "Read files outside the primary project root without asking first.",
    riskLabel: "medium",
  },
  {
    key: "approval.file.host.list",
    group: "Files",
    title: "Off-root directory lists",
    description: "List folders outside the primary project root without approval.",
    riskLabel: "medium",
  },
  {
    key: "approval.file.project.write",
    group: "Files",
    title: "Project file writes",
    description: "Write files inside the primary project root without approval.",
    riskLabel: "medium",
  },
  {
    key: "approval.file.host.write",
    group: "Files",
    title: "Off-root file writes",
    description: "Write files outside the primary project root without approval.",
    riskLabel: "high",
  },
  {
    key: "approval.code.project.create",
    group: "Code edits",
    title: "Project file creation",
    description: "Create code files inside the primary project root without approval.",
    riskLabel: "medium",
  },
  {
    key: "approval.code.project.patch",
    group: "Code edits",
    title: "Project code patches",
    description: "Patch existing files inside the primary project root without approval.",
    riskLabel: "medium",
  },
  {
    key: "approval.code.host.create",
    group: "Code edits",
    title: "Off-root file creation",
    description: "Create code files outside the primary project root without approval.",
    riskLabel: "high",
  },
  {
    key: "approval.code.host.patch",
    group: "Code edits",
    title: "Off-root code patches",
    description: "Patch files outside the primary project root without approval.",
    riskLabel: "high",
  },
  {
    key: "approval.shell.host.cwd",
    group: "Shell",
    title: "Off-root shell cwd",
    description: "Run readonly shell commands from a working directory outside the project root.",
    riskLabel: "medium",
  },
  {
    key: "approval.browser.click",
    group: "Browser",
    title: "Browser clicks",
    description: "Allow Playwright click actions without manual approval.",
    riskLabel: "medium",
  },
  {
    key: "approval.browser.type",
    group: "Browser",
    title: "Browser typing",
    description: "Allow Playwright typing actions without manual approval.",
    riskLabel: "medium",
  },
] as const;

export type ApprovalPreferenceDefinition = (typeof approvalPreferenceDefinitions)[number];
export type ApprovalPreferenceKey = ApprovalPreferenceDefinition["key"];
export type ApprovalPreferenceGroup = ApprovalPreferenceDefinition["group"];
export type ApprovalPreferences = Record<ApprovalPreferenceKey, boolean>;

const approvalPreferenceDefaults = approvalPreferenceDefinitions.reduce((snapshot, definition) => {
  snapshot[definition.key] = false;
  return snapshot;
}, {} as ApprovalPreferences);

export const approvalPreferenceKeys = approvalPreferenceDefinitions.map(
  (definition) => definition.key,
) as ApprovalPreferenceKey[];

export function createDefaultApprovalPreferences(): ApprovalPreferences {
  return { ...approvalPreferenceDefaults };
}

export function isApprovalPreferenceKey(value: string): value is ApprovalPreferenceKey {
  return approvalPreferenceKeys.includes(value as ApprovalPreferenceKey);
}

export function mergeApprovalPreferences(
  updates: Partial<ApprovalPreferences>,
): ApprovalPreferences {
  return {
    ...createDefaultApprovalPreferences(),
    ...updates,
  };
}
