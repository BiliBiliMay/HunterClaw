import { NextResponse } from "next/server";
import { z } from "zod";

import { runAgentTurn } from "@/lib/agent/loop";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { toErrorMessage } from "@/lib/utils";

export const runtime = "nodejs";

const requestSchema = z.object({
  message: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const response = await runAgentTurn({
      message: body.message,
      conversationId: body.conversationId ?? DEFAULT_CONVERSATION_ID,
    });

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error: toErrorMessage(error),
      },
      { status: 400 },
    );
  }
}

