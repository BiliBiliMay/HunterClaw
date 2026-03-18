import { z } from "zod";

import { streamAgentTurn } from "@/lib/agent/loop";
import { createNdjsonStreamResponse } from "@/lib/agent/streaming";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());

    console.info("[api/chat/stream] request accepted", {
      conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
    });

    return createNdjsonStreamResponse("api/chat/stream", async (send) => {
      await streamAgentTurn({
        message: body.message,
        conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
        onEvent: send,
      });
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/chat/stream",
    });
  }
}
