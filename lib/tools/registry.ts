import type { ZodType } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";
import { browserTool } from "@/lib/tools/browserTool";
import { codeTool } from "@/lib/tools/codeTool";
import { fileTool } from "@/lib/tools/fileTool";
import { shellTool } from "@/lib/tools/shellTool";

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  schema: ZodType<TArgs>;
  getRiskLevel(args: TArgs): RiskLevel;
  execute(args: TArgs): Promise<JsonValue>;
}

const tools: ToolDefinition<any>[] = [fileTool, codeTool, shellTool, browserTool];
const toolRegistry = new Map(tools.map((tool) => [tool.name, tool]));

export function listTools() {
  return tools;
}

export function getToolDefinition(toolName: string) {
  const tool = toolRegistry.get(toolName);

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return tool;
}

export function validateToolCall(toolName: string, args: unknown) {
  const tool = getToolDefinition(toolName);
  const parsedArgs = tool.schema.parse(args);

  return {
    tool,
    parsedArgs,
  };
}
