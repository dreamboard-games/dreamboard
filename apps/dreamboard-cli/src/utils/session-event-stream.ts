import { randomUUID } from "node:crypto";
import { getSessionEventBatch } from "@dreamboard-games/api-client";
import type { HostSessionEvent } from "@dreamboard-games/api-client";

const cliSessionEventClientId = `dreamboard-cli-${randomUUID()}`;
const SESSION_EVENT_LONG_POLL_WAIT_MS = 25_000;

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function subscribeToCliSessionEvents(options: {
  sessionId: string;
  signal: AbortSignal;
  clientSource: string;
  playerId: string;
  onSseError?: (error: unknown) => void;
  sseMaxRetryAttempts?: number;
  sseDefaultRetryDelay?: number;
}) {
  return {
    stream: pollCliSessionEvents(options),
    disconnect: async () => undefined,
  };
}

async function* pollCliSessionEvents(options: {
  sessionId: string;
  signal: AbortSignal;
  clientSource: string;
  playerId: string;
  onSseError?: (error: unknown) => void;
}): AsyncGenerator<HostSessionEvent> {
  let afterCursor: number | undefined;

  while (!options.signal.aborted) {
    try {
      const { data, error } = await getSessionEventBatch({
        path: { sessionId: options.sessionId },
        query: {
          playerId: options.playerId,
          clientId: cliSessionEventClientId,
          clientSource: options.clientSource,
          afterCursor,
          waitMs: SESSION_EVENT_LONG_POLL_WAIT_MS,
        },
        signal: options.signal,
      });

      if (error) {
        throw error;
      }
      if (!data) {
        throw new Error("Failed to poll CLI session events");
      }

      afterCursor = data.cursor;

      if (data.snapshot) {
        yield {
          type: "session.snapshot",
          reason: "load",
          snapshot: data.snapshot,
        };
      }

      for (const event of data.events) {
        yield event;
      }
    } catch (error) {
      if (options.signal.aborted || isAbortLikeError(error)) {
        return;
      }
      options.onSseError?.(error);
      throw error;
    }
  }
}
