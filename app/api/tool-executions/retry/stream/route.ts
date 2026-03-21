import { z } from "zod";

import { streamRetryToolExecution } from "@/lib/agent/loop";
import { createSseStreamResponse } from "@/lib/agent/streaming";
import { jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const requestSchema = z.object({
  toolExecutionId: z.string().trim().min(1),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());

    console.info("[api/tool-executions/retry/stream] request accepted", {
      toolExecutionId: body.toolExecutionId,
    });

    return createSseStreamResponse("api/tool-executions/retry/stream", async (send) => {
      await streamRetryToolExecution({
        toolExecutionId: body.toolExecutionId,
        onEvent: send,
      });
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/tool-executions/retry/stream",
    });
  }
}
