import type { ChatStreamEvent } from "@/lib/agent/types";
import { toErrorMessage } from "@/lib/utils";

export function createNdjsonStreamResponse(
  label: string,
  executor: (send: (event: ChatStreamEvent) => Promise<void>) => Promise<void>,
) {
  const encoder = new TextEncoder();

  console.info(`[${label}] stream opened`);

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = async (event: ChatStreamEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };

        try {
          await executor(send);
        } catch (error) {
          console.error(`[${label}] stream failed`, error);
          await send({
            type: "turn.error",
            error: toErrorMessage(error),
            history: null,
          });
        } finally {
          console.info(`[${label}] stream closed`);
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
