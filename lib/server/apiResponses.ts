import { NextResponse } from "next/server";

import { toErrorMessage } from "@/lib/utils";

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export function jsonDataResponse<T>(payload: T, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: JSON_HEADERS,
  });
}

export function jsonErrorResponse({
  error,
  context,
  status = 400,
}: {
  error: unknown;
  context: string;
  status?: number;
}) {
  const message = toErrorMessage(error);

  console.error(`[${context}] ${message}`, error);

  return NextResponse.json(
    {
      error: message,
    },
    {
      status,
      headers: JSON_HEADERS,
    },
  );
}
