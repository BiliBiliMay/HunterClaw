import type { ChatStreamEvent } from "@/lib/agent/types";
import { toErrorMessage } from "@/lib/utils";

function formatSseFrame(event: ChatStreamEvent) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createSseStreamResponse(
  label: string,
  executor: (send: (event: ChatStreamEvent) => Promise<void>) => Promise<void>,
) {
  const encoder = new TextEncoder();

  console.info(`[${label}] stream opened`);

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = async (event: ChatStreamEvent) => {
          controller.enqueue(encoder.encode(formatSseFrame(event)));
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
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
