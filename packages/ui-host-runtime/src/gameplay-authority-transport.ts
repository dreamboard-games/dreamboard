import {
  GameplayAuthorityBackpressureError,
  connectGameplayAuthority,
  type ConnectGameplayAuthorityInput,
  type GameplayAuthorityClient,
  type GameplayCredential,
  type GameplayAuthorityWebSocketFactory,
  type ServerGameplayFrame,
} from "@dreamboard-games/gameplay-authority-client";
import type { SubmitInteractionCommand } from "@dreamboard-games/sdk/plugin-runtime-contract";
import type {
  GameplayConnection,
  GameplayConnectionHandlers,
  GameplayConnectionState,
} from "./gameplay-connection.js";

export interface GameplayAuthorityTransportOptions {
  getCredential: () => Promise<GameplayCredential>;
  webSocketFactory?: GameplayAuthorityWebSocketFactory;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
  randomClientActionId?: () => string;
  now?: () => number;
  schedule?: (delayMs: number, task: () => void) => { cancel(): void };
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  clientConnector?: (
    input: ConnectGameplayAuthorityInput,
  ) => Promise<GameplayAuthorityClient>;
}

const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

export function createGameplayAuthorityTransport(
  options: GameplayAuthorityTransportOptions,
): GameplayConnection {
  return new StatefulGameplayConnection(options);
}

class StatefulGameplayConnection implements GameplayConnection {
  private currentState: GameplayConnectionState = "idle";
  private sessionId: string | null = null;
  private playerId: string | null = null;
  private switchablePlayerIds = new Set<string>();
  private client: GameplayAuthorityClient | null = null;
  private handlers: GameplayConnectionHandlers | null = null;
  private readerAbort: AbortController | null = null;
  private refreshTask: { cancel(): void } | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private explicitClose = false;
  private epoch = 0;
  private latestLogCursor: number | null = null;
  private readonly pendingCommands = new Map<
    string,
    SubmitInteractionCommand
  >();
  private readonly getCredential: () => Promise<GameplayCredential>;
  private websocketUrl = "";
  private credentialKind: GameplayCredential["kind"] = "user";
  private pendingRestores = 0;
  private readonly webSocketFactory?: GameplayAuthorityWebSocketFactory;
  private readonly openTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly randomClientActionId: () => string;
  private readonly now: () => number;
  private readonly schedule: GameplayAuthorityTransportOptions["schedule"];
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private readonly clientConnector: NonNullable<
    GameplayAuthorityTransportOptions["clientConnector"]
  >;

  constructor(options: GameplayAuthorityTransportOptions) {
    this.getCredential = options.getCredential;
    this.webSocketFactory = options.webSocketFactory;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.randomClientActionId =
      options.randomClientActionId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((delayMs, task) => {
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      });
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.random = options.random ?? Math.random;
    this.clientConnector = options.clientConnector ?? connectGameplayAuthority;
  }

  get state(): GameplayConnectionState {
    return this.currentState;
  }

  async connect(input: {
    sessionId: string;
    websocketUrl: string;
    playerId: string;
    switchablePlayerIds: readonly string[];
    lastSeenLogCursor?: number | null;
    handlers: GameplayConnectionHandlers;
  }): Promise<void> {
    this.explicitClose = false;
    this.handlers = input.handlers;
    this.sessionId = input.sessionId;
    this.websocketUrl = input.websocketUrl;
    this.playerId = input.playerId;
    this.switchablePlayerIds = new Set(input.switchablePlayerIds);
    this.latestLogCursor = input.lastSeenLogCursor ?? null;
    try {
      await this.replaceSocket("connecting");
    } catch (error) {
      this.handlers?.onError?.(error);
      await this.reconnect();
    }
  }

  async switchPerspective(playerId: string): Promise<void> {
    if (!this.switchablePlayerIds.has(playerId)) {
      throw new Error(`Gameplay perspective is not authorized: ${playerId}`);
    }
    if (this.pendingCommands.size > 0 || this.pendingRestores > 0) {
      throw new Error(
        "Cannot switch gameplay perspective while interactions are pending.",
      );
    }
    if (playerId === this.playerId) return;
    this.playerId = playerId;
    try {
      await this.replaceSocket("switching-perspective");
    } catch (error) {
      this.handlers?.onError?.(error);
      await this.reconnect();
    }
  }

  async submit(command: SubmitInteractionCommand) {
    if (command.basis.perspectivePlayerId !== this.playerId) {
      throw new Error("Interaction perspective does not match the connection.");
    }
    this.pendingCommands.set(command.clientActionId, command);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const client = await this.requireClient();
        try {
          return await client.submit(command);
        } catch (error) {
          if (error instanceof GameplayAuthorityBackpressureError) {
            throw mapGameplayAuthorityBackpressureError(error);
          }
          if (attempt === 0 && !this.explicitClose) {
            await this.reconnect();
            continue;
          }
          throw error;
        }
      }
      throw new Error("Gameplay interaction retry exhausted.");
    } finally {
      this.pendingCommands.delete(command.clientActionId);
    }
  }

  async restoreHistory(input: { targetVersion: number }): Promise<void> {
    const command = {
      restoreId: this.randomClientActionId(),
      targetVersion: input.targetVersion,
    };
    this.pendingRestores++;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const client = await this.requireClient();
        let frame;
        try {
          frame = await client.restoreHistory(command);
        } catch (error) {
          if (error instanceof GameplayAuthorityBackpressureError)
            throw mapGameplayAuthorityBackpressureError(error);
          if (attempt === 0 && !this.explicitClose) {
            await this.reconnect();
            continue;
          }
          throw error;
        }
        if (frame.type === "history.restoreRejected")
          throw new Error(frame.message);
        return;
      }
      throw new Error("Gameplay restore retry exhausted.");
    } finally {
      this.pendingRestores--;
    }
  }

  close(): void {
    this.explicitClose = true;
    this.epoch += 1;
    this.refreshTask?.cancel();
    this.refreshTask = null;
    this.readerAbort?.abort();
    this.readerAbort = null;
    this.client?.close();
    this.client = null;
    this.reconnectPromise = null;
    this.pendingCommands.clear();
    this.setState("closed");
  }

  private async replaceSocket(
    state: "connecting" | "switching-perspective" | "reconnecting",
  ): Promise<void> {
    const sessionId = this.sessionId;
    const playerId = this.playerId;
    if (!sessionId || !playerId) {
      throw new Error("Gameplay connection scope is missing.");
    }
    const epoch = ++this.epoch;
    this.setState(state);
    this.refreshTask?.cancel();
    this.readerAbort?.abort();
    this.client?.close();
    this.client = null;

    const credential = await this.getCredential();
    if (epoch !== this.epoch || this.explicitClose) return;
    const client = await this.clientConnector({
      websocketUrl: this.websocketUrl,
      credential,
      sessionId,
      playerId,
      webSocketFactory: this.webSocketFactory,
      openTimeoutMs: this.openTimeoutMs,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (epoch !== this.epoch || this.explicitClose) {
      client.close();
      return;
    }
    this.client = client;
    this.credentialKind = credential.kind;
    const ready = deferred<void>();
    this.startReader(client, epoch, ready);
    client.resume({
      lastSeenLogCursor: this.latestLogCursor,
      unacknowledgedClientActionIds: [...this.pendingCommands.keys()],
    });
    await ready.promise;
    if (epoch !== this.epoch || this.explicitClose) return;
    this.scheduleRefresh(client, epoch);
  }

  private startReader(
    client: GameplayAuthorityClient,
    epoch: number,
    ready: Deferred<void>,
  ): void {
    const abort = new AbortController();
    this.readerAbort = abort;
    void (async () => {
      try {
        for await (const frame of client.frames(abort.signal)) {
          if (epoch !== this.epoch) return;
          this.handleFrame(frame);
          if (frame.type === "session.snapshot") ready.resolve();
        }
        if (
          !abort.signal.aborted &&
          epoch === this.epoch &&
          !this.explicitClose
        ) {
          ready.reject(new Error("Gameplay socket closed before resume."));
          void this.reconnect();
        }
      } catch (error) {
        if (
          !abort.signal.aborted &&
          epoch === this.epoch &&
          !this.explicitClose
        ) {
          ready.reject(error);
          this.handlers?.onError?.(error);
          void this.reconnect();
        }
      }
    })();
  }

  private handleFrame(frame: ServerGameplayFrame): void {
    if (frame.type === "session.snapshot") {
      this.setState("open");
      this.handlers?.onEvent({
        type: "session.gameplayUpdated",
        gameplay: frame.boardStatic
          ? {
              ...frame.frame,
              view: mergeGameplayView(frame.boardStatic.view, frame.frame.view),
            }
          : frame.frame,
        history: frame.history,
        lifecycle: frame.lifecycle,
      });
      return;
    }
    if (frame.type === "gameplay.logs") {
      for (const entry of frame.entries) {
        this.latestLogCursor = entry.cursor;
        this.handlers?.onEvent({ type: "session.gameplayLog", entry });
      }
      return;
    }
    if (frame.type === "gameplay.logs.reset") {
      this.latestLogCursor = frame.cursor;
      this.handlers?.onEvent({
        type: "session.gameplayLogsReset",
        cursor: frame.cursor,
        reason: frame.reason,
      });
      return;
    }
    if (frame.type === "gameplay.backpressure") {
      this.handlers?.onRecovering?.({
        message: frame.message,
        retryAfterMs: frame.retryAfterMs,
        attempt: 1,
      });
    }
  }

  private scheduleRefresh(
    client: GameplayAuthorityClient,
    epoch: number,
  ): void {
    if (this.credentialKind === "demo") return;
    const expiresAt = Date.parse(client.expiresAt);
    const ttlMs = Math.max(1, expiresAt - this.now());
    const safetyMs = Math.min(60_000, ttlMs * 0.2);
    const delayMs = Math.max(0, ttlMs - safetyMs);
    this.refreshTask =
      this.schedule?.(delayMs, () => {
        void this.refresh(client, epoch);
      }) ?? null;
  }

  private async refresh(client: GameplayAuthorityClient, epoch: number) {
    if (epoch !== this.epoch || this.explicitClose) return;
    this.setState("refreshing");
    try {
      const sessionId = this.sessionId;
      const playerId = this.playerId;
      if (!sessionId || !playerId) return;
      const previousExpiry = client.expiresAt;
      await client.refresh(await this.getCredential());
      if (epoch === this.epoch) {
        this.setState("open");
        if (client.expiresAt !== previousExpiry)
          this.scheduleRefresh(client, epoch);
      }
    } catch {
      if (epoch === this.epoch && !this.explicitClose) await this.reconnect();
    }
  }

  private reconnect(): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      for (let attempt = 1; !this.explicitClose; attempt += 1) {
        const base = Math.min(MAX_RECONNECT_DELAY_MS, 100 * 2 ** (attempt - 1));
        const delayMs = Math.round(base * (0.75 + this.random() * 0.5));
        this.setState("reconnecting");
        this.handlers?.onRecovering?.({
          message: "Gameplay connection interrupted; reconnecting.",
          retryAfterMs: delayMs,
          attempt,
        });
        await this.sleep(delayMs);
        try {
          await this.replaceSocket("reconnecting");
          return;
        } catch (error) {
          this.handlers?.onError?.(error);
        }
      }
    })().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  private async requireClient(): Promise<GameplayAuthorityClient> {
    if (this.client) return this.client;
    if (this.reconnectPromise) await this.reconnectPromise;
    if (!this.client) throw new Error("Gameplay connection is not open.");
    return this.client;
  }

  private setState(state: GameplayConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.handlers?.onStateChange(state);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mapGameplayAuthorityBackpressureError(
  error: GameplayAuthorityBackpressureError,
) {
  return {
    title: "Session recovering",
    status: 503,
    detail: error.message,
    retryable: true,
    context: {
      retryAfterMs: error.retryAfterMs,
      reason: error.reason,
      operation: error.operation,
      clientActionId: error.clientActionId,
      restoreId: error.restoreId,
    },
  };
}

function mergeGameplayView(staticView: unknown, dynamicView: unknown): unknown {
  if (staticView === null || staticView === undefined) return dynamicView;
  if (dynamicView === null) return staticView;
  if (
    typeof staticView === "object" &&
    !Array.isArray(staticView) &&
    typeof dynamicView === "object" &&
    !Array.isArray(dynamicView)
  ) {
    return { ...staticView, ...dynamicView };
  }
  return dynamicView;
}
