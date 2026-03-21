import { z } from "zod";

import { retryToolExecution } from "@/lib/agent/loop";
import { jsonDataResponse, jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const requestSchema = z.object({
  toolExecutionId: z.string().trim().min(1),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const response = await retryToolExecution(body);

    return jsonDataResponse(response);
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/tool-executions/retry",
    });
  }
}
