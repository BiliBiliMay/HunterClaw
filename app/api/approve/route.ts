import { NextResponse } from "next/server";
import { z } from "zod";

import { handleApprovalDecision } from "@/lib/agent/loop";
import { toErrorMessage } from "@/lib/utils";

export const runtime = "nodejs";

const requestSchema = z.object({
  requestId: z.string().trim().min(1),
  decision: z.enum(["approve", "deny"]),
});

export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await request.json());
    const response = await handleApprovalDecision(body);

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

