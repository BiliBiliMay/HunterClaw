import {
  createConversation,
  listConversations,
} from "@/lib/agent/memory";
import {
  jsonDataResponse,
  jsonErrorResponse,
} from "@/lib/server/apiResponses";

export const runtime = "nodejs";

export async function GET() {
  try {
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
  }
}
