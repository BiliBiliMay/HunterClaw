import { getHistoryPayload } from "@/lib/agent/memory";
import { DEFAULT_CONVERSATION_ID } from "@/lib/agent/types";
import { jsonDataResponse, jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId") ?? DEFAULT_CONVERSATION_ID;
    const history = await getHistoryPayload(conversationId);

    return jsonDataResponse(history);
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/history",
    });
  }
}
