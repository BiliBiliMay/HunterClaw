import { z } from "zod";

import { handleApprovalDecision } from "@/lib/agent/loop";
import { jsonDataResponse, jsonErrorResponse } from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const requestSchema = z.object({
  requestId: z.string().trim().min(1),
  decision: z.enum(["approve", "deny"]),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const response = await handleApprovalDecision(body);

    return jsonDataResponse(response);
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/approve",
    });
  }
}
