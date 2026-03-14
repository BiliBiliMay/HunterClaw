import { NextResponse } from "next/server";

import { getHistoryPayload } from "@/lib/agent/memory";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { toErrorMessage } from "@/lib/utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId") ?? DEFAULT_CONVERSATION_ID;
    const history = await getHistoryPayload(conversationId);

    return NextResponse.json(history);
  } catch (error) {
    return NextResponse.json(
      {
        error: toErrorMessage(error),
      },
      { status: 400 },
    );
  }
}

