import { z } from "zod";

import {
  isApprovalPreferenceKey,
  type ApprovalPreferences,
} from "@/lib/agent/approvalPreferences";
import {
  getApprovalPreferences,
  updateApprovalPreferences,
} from "@/lib/agent/memory";
import {
  jsonDataResponse,
  jsonErrorResponse,
} from "@/lib/server/apiResponses";

export const runtime = "nodejs";

const patchRequestSchema = z.object({
  preferences: z.record(z.boolean()).default({}),
});

function normalizeApprovalPreferenceUpdates(input: Record<string, boolean>) {
  const updates: Partial<ApprovalPreferences> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!isApprovalPreferenceKey(key)) {
      throw new Error(`Unknown approval preference: ${key}`);
    }

    updates[key] = value;
  }

  return updates;
}

export async function GET() {
  try {
    return jsonDataResponse({
      preferences: await getApprovalPreferences(),
    });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/preferences:get",
    });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = patchRequestSchema.parse(await request.json());
    const preferences = await updateApprovalPreferences(
      normalizeApprovalPreferenceUpdates(body.preferences),
    );

    return jsonDataResponse({ preferences });
  } catch (error) {
    return jsonErrorResponse({
      error,
      context: "api/preferences:patch",
    });
  }
}
