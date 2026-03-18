<<<<<<< HEAD
import {
  createConversation,
  listConversations,
} from "@/lib/agent/memory";
import {
  jsonDataResponse,
  jsonErrorResponse,
} from "@/lib/server/apiResponses";
=======
import { NextResponse } from "next/server";

import { listConversations } from "@/lib/agent/memory";
import { toErrorMessage } from "@/lib/utils";
>>>>>>> 6622509 (feat: Add conversation management to the agent CLI with new commands and API routes.)

export const runtime = "nodejs";

export async function GET() {
  try {
<<<<<<< HEAD
    return jsonDataResponse({
      conversations: await listConversations(),
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/conversations:get",
    });
  }
}

export async function POST() {
  try {
    return jsonDataResponse({
      conversation: await createConversation(),
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/conversations:post",
    });
=======
    const conversations = await listConversations();
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json(
      {
        error: toErrorMessage(error),
      },
      { status: 400 },
    );
>>>>>>> 6622509 (feat: Add conversation management to the agent CLI with new commands and API routes.)
  }
}
