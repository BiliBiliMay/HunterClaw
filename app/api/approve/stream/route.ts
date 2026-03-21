import { z } from "zod";

import { streamApprovalDecision } from "@/lib/agent/loop";
import { createSseStreamResponse } from "@/lib/agent/streaming";
import { jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const requestSchema = z.object({
  requestId: z.string().trim().min(1),
  decision: z.enum(["approve", "deny"]),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());

    console.info("[api/approve/stream] request accepted", {
      requestId: body.requestId,
      decision: body.decision,
    });

    return createSseStreamResponse("api/approve/stream", async (send) => {
      await streamApprovalDecision({
        requestId: body.requestId,
        decision: body.decision,
        onEvent: send,
      });
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/approve/stream",
    });
  }
}
