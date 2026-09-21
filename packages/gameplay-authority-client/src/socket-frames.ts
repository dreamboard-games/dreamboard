import {
  ServerGameplayFrameSchema,
  type ServerGameplayFrame,
} from "@dreamboard-games/gameplay-authority-protocol";

export interface GameplayAuthorityWebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export async function waitUntilOpen(
  socket: GameplayAuthorityWebSocketLike,
  timeoutMs: number,
): Promise<void> {
  await waitForEvent(socket, "open", timeoutMs);
}

async function waitForEvent(
  socket: GameplayAuthorityWebSocketLike,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = installSocketListeners(socket, {
      timeoutMs,
      onEvent(observed) {
        if (observed === event) {
          cleanup();
          resolve();
        }
      },
      onError(error) {
        cleanup();
        reject(
          error instanceof Error ? error : new Error("gameplay socket error"),
        );
      },
      onClose() {
        cleanup();
        reject(new Error("gameplay socket closed"));
      },
      onTimeout() {
        cleanup();
        reject(new Error("gameplay socket timed out"));
      },
    });
  });
}

export async function waitForServerFrame(
  socket: GameplayAuthorityWebSocketLike,
  predicate: (frame: ServerGameplayFrame) => boolean,
  timeoutMs: number,
): Promise<ServerGameplayFrame> {
  return new Promise((resolve, reject) => {
    const cleanup = installSocketListeners(socket, {
      timeoutMs,
      onMessage(data) {
        let frame: ServerGameplayFrame;
        try {
          frame = ServerGameplayFrameSchema.parse(
            JSON.parse(messageToString(data)),
          );
        } catch (error) {
          cleanup();
          reject(
            error instanceof Error
              ? error
              : new Error("invalid gameplay authority frame"),
          );
          return;
        }
        if (predicate(frame)) {
          cleanup();
          resolve(frame);
        }
      },
      onError(error) {
        cleanup();
        reject(
          error instanceof Error ? error : new Error("gameplay socket error"),
        );
      },
      onClose() {
        cleanup();
        reject(new Error("gameplay socket closed"));
      },
      onTimeout() {
        cleanup();
        reject(new Error("gameplay socket timed out"));
      },
    });
  });
}

function installSocketListeners(
  socket: GameplayAuthorityWebSocketLike,
  handlers: {
    timeoutMs: number;
    onEvent?: (event: string) => void;
    onMessage?: (data: unknown) => void;
    onError(error: unknown): void;
    onClose(): void;
    onTimeout(): void;
  },
): () => void {
  const timer = setTimeout(handlers.onTimeout, handlers.timeoutMs);
  const onOpen = () => handlers.onEvent?.("open");
  const onMessage = (event: Event) =>
    handlers.onMessage?.((event as MessageEvent).data);
  const onError = (event: Event) => handlers.onError(event);
  const onClose = () => handlers.onClose();

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);

  return () => {
    clearTimeout(timer);
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
  };
}

export function readServerFrames(
  socket: GameplayAuthorityWebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<ServerGameplayFrame> {
  const queue: ServerGameplayFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let error: Error | null = null;

  const wakeReader = () => {
    wake?.();
    wake = null;
  };
  const onMessage = (event: Event) => {
    try {
      queue.push(
        ServerGameplayFrameSchema.parse(
          JSON.parse(messageToString((event as MessageEvent).data)),
        ),
      );
    } catch (candidate) {
      error =
        candidate instanceof Error
          ? candidate
          : new Error("invalid gameplay authority frame");
    }
    wakeReader();
  };
  const onError = (event: Event) => {
    error = event instanceof Error ? event : new Error("gameplay socket error");
    wakeReader();
  };
  const onClose = () => {
    closed = true;
    wakeReader();
  };
  const onAbort = () => {
    closed = true;
    wakeReader();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });

  const cleanup = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  };

  const iterator: AsyncGenerator<ServerGameplayFrame> = {
    async next() {
      while (!closed && !signal?.aborted) {
        const next = queue.shift();
        if (next) {
          return { done: false, value: next };
        }
        if (error) {
          cleanup();
          throw error;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      cleanup();
      if (error) {
        throw error;
      }
      return { done: true, value: undefined };
    },
    async return(value?: unknown) {
      closed = true;
      wakeReader();
      cleanup();
      return { done: true, value: value as ServerGameplayFrame };
    },
    async throw(candidate?: unknown) {
      closed = true;
      wakeReader();
      cleanup();
      throw candidate;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await this.return(undefined);
    },
  };

  return iterator;
}

function messageToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}
