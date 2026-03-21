import type { ChatStreamEvent } from "@/lib/agent/types";

const MAX_ERROR_SNIPPET = 220;

type JsonErrorPayload = {
  error?: string;
};

function normalizeSnippet(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= MAX_ERROR_SNIPPET) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_ERROR_SNIPPET - 3).trimEnd()}...`;
}

function isJsonContentType(contentType: string | null) {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json") || normalized.includes("+json");
}

function isSseContentType(contentType: string | null) {
  return Boolean(contentType?.toLowerCase().includes("text/event-stream"));
}

async function readTextBody(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJsonErrorPayload(bodyText: string) {
  if (!bodyText) {
    return null;
  }

  try {
    const payload = JSON.parse(bodyText) as JsonErrorPayload;

    if (payload && typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function buildHttpError({
  fallbackMessage,
  response,
  bodyText,
  invalidContentType,
}: {
  fallbackMessage: string;
  response: Response;
  bodyText: string;
  invalidContentType?: string | null;
}) {
  const snippet = normalizeSnippet(bodyText);
  const contentTypeDetail = invalidContentType
    ? `received ${invalidContentType}`
    : `HTTP ${response.status}`;
  const suffix = snippet ? ` ${snippet}` : "";

  return new Error(`${fallbackMessage}: ${contentTypeDetail}.${suffix}`.trim());
}

export async function fetchJsonOrTextError<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackMessage: string,
): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type");
  const bodyText = await readTextBody(response);

  if (!isJsonContentType(contentType)) {
    throw buildHttpError({
      fallbackMessage,
      response,
      bodyText,
      invalidContentType: contentType ?? "unknown content type",
    });
  }

  let payload: T | JsonErrorPayload;

  try {
    payload = bodyText ? (JSON.parse(bodyText) as T | JsonErrorPayload) : ({} as T);
  } catch {
    const snippet = normalizeSnippet(bodyText);
    throw new Error(
      snippet
        ? `${fallbackMessage}: invalid JSON response. ${snippet}`
        : `${fallbackMessage}: invalid JSON response.`,
    );
  }

  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
    throw new Error(payload.error.trim());
  }

  if (!response.ok) {
    throw buildHttpError({
      fallbackMessage,
      response,
      bodyText,
    });
  }

  return payload as T;
}

function parseSseFrame(frame: string, fallbackMessage: string) {
  let eventType: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join("\n");

  try {
    const parsed = JSON.parse(data) as ChatStreamEvent;

    if (eventType && parsed.type !== eventType) {
      throw new Error(`event type mismatch (${eventType} != ${parsed.type})`);
    }

    return parsed;
  } catch {
    const snippet = normalizeSnippet(frame);
    throw new Error(
      snippet
        ? `${fallbackMessage}: streaming response was not valid SSE. ${snippet}`
        : `${fallbackMessage}: streaming response was not valid SSE.`,
    );
  }
}

export async function consumeSseStream({
  input,
  init,
  fallbackMessage,
  onEvent,
}: {
  input: RequestInfo | URL;
  init?: RequestInit;
  fallbackMessage: string;
  onEvent: (event: ChatStreamEvent) => Promise<void> | void;
}) {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    const bodyText = await readTextBody(response);
    const jsonError = isJsonContentType(contentType) ? parseJsonErrorPayload(bodyText) : null;

    if (jsonError) {
      throw new Error(jsonError);
    }

    throw buildHttpError({
      fallbackMessage,
      response,
      bodyText,
      invalidContentType: isJsonContentType(contentType) ? undefined : (contentType ?? "unknown content type"),
    });
  }

  if (!isSseContentType(contentType)) {
    const bodyText = await readTextBody(response);
    throw buildHttpError({
      fallbackMessage,
      response,
      bodyText,
      invalidContentType: contentType ?? "unknown content type",
    });
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error(`${fallbackMessage}: streaming response body is unavailable.`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);

      if (!boundary || boundary.index == null) {
        break;
      }

      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const parsed = parseSseFrame(frame, fallbackMessage);

      if (parsed) {
        await onEvent(parsed);
      }
    }
  }

  buffer += decoder.decode();

  const trailingFrame = buffer.trim();
  if (!trailingFrame) {
    return;
  }

  const parsed = parseSseFrame(trailingFrame, fallbackMessage);
  if (parsed) {
    await onEvent(parsed);
  }
}
