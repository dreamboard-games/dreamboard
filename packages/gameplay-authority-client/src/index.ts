import {
  type ServerGameplayFrame,
  type GameplayCredential,
} from "@dreamboard-games/gameplay-authority-protocol";
import type {
  InteractionResult,
  SubmitInteractionCommand,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import { encodeClientGameplayFrame } from "./client-frame-codec.js";
import {
  readServerFrames,
  waitForServerFrame,
  waitUntilOpen,
  type GameplayAuthorityWebSocketLike,
} from "./socket-frames.js";

export type {
  ServerGameplayFrame,
  GameplayCredential,
} from "@dreamboard-games/gameplay-authority-protocol";
export type { GameplayAuthorityWebSocketLike } from "./socket-frames.js";

export interface GameplayAuthorityWebSocketInit {
  headers?: Record<string, string>;
}

export type GameplayAuthorityWebSocketFactory = new (
  url: string,
  init?: GameplayAuthorityWebSocketInit,
) => GameplayAuthorityWebSocketLike;

export interface ConnectGameplayAuthorityInput {
  websocketUrl: string;
  credential: GameplayCredential;
  sessionId: string;
  playerId: string;
  webSocketFactory?: GameplayAuthorityWebSocketFactory;
  webSocketInit?: GameplayAuthorityWebSocketInit;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface GameplayAuthorityClient {
  readonly expiresAt: string;
  refresh(credential: GameplayCredential): Promise<{ expiresAt: string }>;
  resume(input?: ResumeGameplaySessionInput): void;
  submit(command: SubmitInteractionCommand): Promise<InteractionResult>;
  restoreHistory(
    input: RestoreGameplayHistoryInput,
  ): Promise<HistoryRestoredFrame | HistoryRestoreRejectedFrame>;
  frames(signal?: AbortSignal): AsyncGenerator<ServerGameplayFrame>;
  close(): void;
}

export type HistoryRestoredFrame = Extract<
  ServerGameplayFrame,
  { type: "history.restored" }
>;

export interface ResumeGameplaySessionInput {
  lastSeenLogCursor?: number | null;
  unacknowledgedClientActionIds?: string[];
}

export interface RestoreGameplayHistoryInput {
  restoreId: string;
  targetVersion: number;
}

export type HistoryRestoreRejectedFrame = Extract<
  ServerGameplayFrame,
  { type: "history.restoreRejected" }
>;

export type GameplayBackpressureFrame = Extract<
  ServerGameplayFrame,
  { type: "gameplay.backpressure" }
>;

const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class GameplayAuthorityBackpressureError extends Error {
  readonly reason: GameplayBackpressureFrame["reason"];
  readonly retryAfterMs: number;
  readonly operation: GameplayBackpressureFrame["operation"];
  readonly clientActionId?: string;
  readonly restoreId?: string;

  constructor(frame: GameplayBackpressureFrame) {
    super(frame.message);
    this.name = "GameplayAuthorityBackpressureError";
    this.reason = frame.reason;
    this.retryAfterMs = frame.retryAfterMs;
    this.operation = frame.operation;
    this.clientActionId = frame.clientActionId;
    this.restoreId = frame.restoreId;
  }
}

export async function connectGameplayAuthority(
  input: ConnectGameplayAuthorityInput,
): Promise<GameplayAuthorityClient> {
  const usesDefaultWebSocketFactory = !input.webSocketFactory;
  if (
    usesDefaultWebSocketFactory &&
    input.webSocketInit?.headers &&
    Object.keys(input.webSocketInit.headers).length > 0
  ) {
    throw new Error(
      "Browser WebSocket does not support custom headers; provide a webSocketFactory for header-aware runtimes.",
    );
  }
  const webSocketFactory = input.webSocketFactory ?? browserWebSocketFactory();
  const webSocketInit = usesDefaultWebSocketFactory
    ? undefined
    : input.webSocketInit;
  const openTimeoutMs = input.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const socket = new webSocketFactory(input.websocketUrl, webSocketInit);

  try {
    await waitUntilOpen(socket, openTimeoutMs);
    socket.send(
      encodeClientGameplayFrame({
        type: "auth.connect",
        credential: input.credential,
        sessionId: input.sessionId,
        playerId: input.playerId,
      }),
    );
    const accepted = await waitForServerFrame(
      socket,
      (frame) => frame.type === "auth.accepted",
      requestTimeoutMs,
    );
    if (accepted.type !== "auth.accepted") {
      throw new Error("Unexpected gameplay authority authentication frame.");
    }
    return new WebSocketGameplayAuthorityClient(
      socket,
      requestTimeoutMs,
      accepted.expiresAt,
    );
  } catch (error) {
    socket.close();
    throw error;
  }
}

class WebSocketGameplayAuthorityClient implements GameplayAuthorityClient {
  constructor(
    private readonly socket: GameplayAuthorityWebSocketLike,
    private readonly requestTimeoutMs: number,
    public expiresAt: string,
  ) {}

  async refresh(
    credential: GameplayCredential,
  ): Promise<{ expiresAt: string }> {
    this.socket.send(
      encodeClientGameplayFrame({ type: "auth.refresh", credential }),
    );
    const frame = await waitForServerFrame(
      this.socket,
      (candidate) => candidate.type === "auth.accepted",
      this.requestTimeoutMs,
    );
    if (frame.type !== "auth.accepted") {
      throw new Error("Unexpected gameplay authority refresh frame.");
    }
    this.expiresAt = frame.expiresAt;
    return { expiresAt: frame.expiresAt };
  }

  resume(input: ResumeGameplaySessionInput = {}): void {
    this.socket.send(
      encodeClientGameplayFrame({
        type: "session.resume",
        lastSeenLogCursor: input.lastSeenLogCursor ?? null,
        unacknowledgedClientActionIds:
          input.unacknowledgedClientActionIds ?? [],
      }),
    );
  }

  async submit(command: SubmitInteractionCommand): Promise<InteractionResult> {
    this.socket.send(encodeClientGameplayFrame(command));

    const frame = await waitForServerFrame(
      this.socket,
      (candidate) =>
        (candidate.type === "gameplay.backpressure" &&
          candidate.operation === "interaction.submit" &&
          candidate.clientActionId === command.clientActionId) ||
        (candidate.type === "interaction.result" &&
          candidate.clientActionId === command.clientActionId),
      this.requestTimeoutMs,
    );

    throwIfBackpressure(frame);
    if (frame.type !== "interaction.result") {
      throw new Error("Unexpected gameplay authority command frame.");
    }
    return frame;
  }

  async restoreHistory(
    input: RestoreGameplayHistoryInput,
  ): Promise<HistoryRestoredFrame | HistoryRestoreRejectedFrame> {
    this.socket.send(
      encodeClientGameplayFrame({
        type: "history.restore",
        restoreId: input.restoreId,
        targetVersion: input.targetVersion,
      }),
    );

    const frame = await waitForServerFrame(
      this.socket,
      (candidate) =>
        (candidate.type === "gameplay.backpressure" &&
          candidate.operation === "history.restore" &&
          candidate.restoreId === input.restoreId) ||
        (candidate.type === "history.restored" &&
          candidate.restoreId === input.restoreId) ||
        (candidate.type === "history.restoreRejected" &&
          candidate.restoreId === input.restoreId),
      this.requestTimeoutMs,
    );

    throwIfBackpressure(frame);
    if (
      frame.type !== "history.restored" &&
      frame.type !== "history.restoreRejected"
    ) {
      throw new Error("Unexpected gameplay authority history frame.");
    }
    return frame;
  }

  frames(signal?: AbortSignal): AsyncGenerator<ServerGameplayFrame> {
    return readServerFrames(this.socket, signal);
  }

  close(): void {
    this.socket.close();
  }
}

function throwIfBackpressure(frame: ServerGameplayFrame): void {
  if (frame.type === "gameplay.backpressure") {
    throw new GameplayAuthorityBackpressureError(frame);
  }
}

function browserWebSocketFactory(): GameplayAuthorityWebSocketFactory {
  // The native browser `WebSocket` already satisfies GameplayAuthorityWebSocketLike
  // (send/close/addEventListener/removeEventListener); its constructor's second
  // argument is `protocols`, which the header guard in connectGameplayAuthority keeps
  // callers from misusing on this default factory.
  return WebSocket as unknown as GameplayAuthorityWebSocketFactory;
}
