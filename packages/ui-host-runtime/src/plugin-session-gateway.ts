import type {
  InteractionResult,
  PluginGameplayFrame,
  PluginSessionDescriptor,
  SubmitInteractionCommand,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import { PluginBridge } from "./plugin-bridge.js";
import type { LoggerLike } from "./logger.js";
import { consoleLogger } from "./logger.js";
import { PERF_MARK_NAMES, findActionIdBySyncId, recordMark } from "./perf.js";

export interface GameSessionStoreApi {
  getGameplayFrame: () => PluginGameplayFrame | null;
  subscribe: (callback: () => void) => () => void;
  onStateAck: (syncId: number, basis?: PluginGameplayFrame["basis"]) => void;
}

export type GatewayState = "loading" | "handshaking" | "connected" | "error";

export interface PluginSessionGatewayConfig {
  iframe: HTMLIFrameElement;
  sessionId: string;
  controllablePlayerIds: string[];
  userId: string | null;
  expectedSdkVersion?: string | null;
  onReady: () => void;
  onError: (error: Error) => void;
  onInteraction: (command: SubmitInteractionCommand) => void | Promise<void>;
  logger?: LoggerLike;
}

export class PluginSessionGateway {
  private bridge: PluginBridge | null = null;
  private state: GatewayState = "loading";
  private unsubscribeHandlers: Array<() => void> = [];
  private config: PluginSessionGatewayConfig;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private initStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private initRetryInterval: ReturnType<typeof setInterval> | null = null;
  private storeUnsubscribe: (() => void) | null = null;
  private gameSessionStore: GameSessionStoreApi | null = null;
  private lastSentFrameKey: string | null = null;
  private sequenceToBasis = new Map<number, PluginGameplayFrame["basis"]>();
  private logger: LoggerLike;

  constructor(config: PluginSessionGatewayConfig) {
    this.config = config;
    this.logger = config.logger ?? consoleLogger;
  }

  connect(): void {
    if (this.bridge) {
      this.logger.warn("[Gateway] Already connected");
      return;
    }

    this.state = "loading";

    this.bridge = new PluginBridge(this.config.iframe, undefined, {
      logger: this.logger,
    });

    this.readyTimeout = setTimeout(() => {
      if (this.state !== "connected") {
        this.handleError(
          new Error(
            this.withVersionHint(
              "Plugin failed to send ready message within 10 seconds.",
            ),
          ),
        );
      }
    }, 10000);

    this.setupInteractionHandler();
    this.setupReadyHandler();
    this.setupErrorHandler();
    this.setupStateAckHandler();

    this.state = "handshaking";

    this.initStartTimeout = setTimeout(() => {
      this.initStartTimeout = null;
      if (this.state === "error") {
        return;
      }
      this.sendInit();
      this.initRetryInterval = setInterval(() => {
        if (this.state === "connected") {
          this.clearInitRetryInterval();
          return;
        }
        this.sendInit();
      }, 250);
    }, 50);
  }

  attachStore(store: GameSessionStoreApi): void {
    if (this.state !== "connected") {
      this.logger.warn(
        "[Gateway] Cannot attach store - plugin not ready yet (state: " +
          this.state +
          ")",
      );
      return;
    }

    if (this.storeUnsubscribe) {
      this.logger.warn("[Gateway] Store already attached");
      return;
    }

    this.gameSessionStore = store;

    this.flushGameplayFrame();

    this.storeUnsubscribe = store.subscribe(() => {
      this.flushGameplayFrame();
    });
  }

  flushGameplayFrame(): void {
    if (!this.bridge || !this.gameSessionStore) return;

    const frame = this.gameSessionStore.getGameplayFrame();
    if (!frame) return;

    const frameKey = this.frameDeliveryKey(frame);

    if (frameKey !== this.lastSentFrameKey) {
      this.lastSentFrameKey = frameKey;
      const basis = frame.basis;
      this.logger.log("[Gateway] Gameplay frame view present:", {
        gameVersion: basis.version,
        actionSetVersion: basis.actionSetVersion,
        hasView: frame.view !== null,
        perspectivePlayerId: basis.perspectivePlayerId,
      });
      const sequence = this.bridge.sendGameplayFrame(frame);
      if (sequence !== null) {
        this.sequenceToBasis.set(sequence, basis);
      }
      // Tier-0 perf: stitch the outgoing gameplay frame to the action
      // that caused it (via the syncId -> actionId map populated
      // at `t5_store_applied`). For non-action-driven syncs (lobby
      // updates etc.) the lookup returns undefined and the mark is
      // a no-op.
      const actionId = findActionIdBySyncId(basis.version);
      if (actionId) {
        recordMark(actionId, PERF_MARK_NAMES.T6_STATE_SYNC_POSTED, {
          extra: { syncId: basis.version },
        });
      }
      this.logger.log("[Gateway] Sent gameplay frame:", basis.version);
    }
  }

  getState(): GatewayState {
    return this.state;
  }

  disconnect(): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }

    if (this.initStartTimeout) {
      clearTimeout(this.initStartTimeout);
      this.initStartTimeout = null;
    }

    this.clearInitRetryInterval();

    if (this.bridge) {
      this.bridge.disconnect();
      this.bridge = null;
    }

    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }

    this.unsubscribeHandlers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribeHandlers = [];

    this.state = "loading";
    this.lastSentFrameKey = null;
    this.sequenceToBasis.clear();
  }

  private frameDeliveryKey(frame: PluginGameplayFrame): string {
    return JSON.stringify(frame.basis);
  }

  private setupReadyHandler(): void {
    if (!this.bridge) return;

    const unsubscribe = this.bridge.onPluginMessage("runtime.ready", () => {
      if (this.readyTimeout) {
        clearTimeout(this.readyTimeout);
        this.readyTimeout = null;
      }
      this.clearInitRetryInterval();

      this.state = "connected";

      this.config.onReady();
    });

    this.unsubscribeHandlers.push(unsubscribe);
  }

  private sendInit(): void {
    if (!this.bridge) {
      return;
    }

    this.bridge.sendInit(this.currentPluginSessionDescriptor());
  }

  private clearInitRetryInterval(): void {
    if (this.initRetryInterval) {
      clearInterval(this.initRetryInterval);
      this.initRetryInterval = null;
    }
  }

  private setupInteractionHandler(): void {
    if (!this.bridge) return;

    const unsubscribe = this.bridge.onPluginMessage(
      "interaction.submit",
      async (message) => {
        // Tier-0 perf: record plugin-supplied `t0_click` and our own
        // `t1_host_received` against the client-minted actionId so the
        // rest of the pipeline (http submit, Live, store apply) can
        // attach their marks to the same entry.
        try {
          await this.config.onInteraction(message);
          this.sendSubmitResult({
            type: "interaction.result",
            clientActionId: message.clientActionId,
            accepted: true,
          });
        } catch (error) {
          this.logger.error("[Gateway] Interaction submission error:", error);
          this.sendSubmitResult({
            type: "interaction.result",
            clientActionId: message.clientActionId,
            ...this.describeSubmissionFailure(error, "Interaction rejected"),
          });
        }
      },
    );

    this.unsubscribeHandlers.push(unsubscribe);
  }

  private setupErrorHandler(): void {
    if (!this.bridge) return;

    const unsubscribe = this.bridge.onPluginMessage(
      "runtime.error",
      (message) => {
        if (this.isRecoverablePluginError(message)) {
          this.logger.warn(
            "[Gateway] Recoverable plugin submission timeout ignored.",
          );
          return;
        }
        this.logger.error("[Gateway] Plugin error:", message.message);
        if (message.code) {
          this.logger.error("[Gateway] Error code:", message.code);
        }
        const error = new Error(
          this.withVersionHint(
            message.code
              ? `${message.code}: ${message.message}`
              : message.message,
          ),
        );
        error.name = "PluginRuntimeError";
        this.handleError(error);
      },
    );

    this.unsubscribeHandlers.push(unsubscribe);
  }

  private isRecoverablePluginError(message: {
    code?: string | null;
    message: string;
  }): boolean {
    return (
      message.code === "UNHANDLED_REJECTION" &&
      message.message.includes("Submission request timed out")
    );
  }

  private withVersionHint(message: string): string {
    const expectedSdkVersion = this.config.expectedSdkVersion?.trim();
    if (!expectedSdkVersion) {
      return message;
    }
    return `${message} Host expected @dreamboard-games/sdk version: ${expectedSdkVersion}. Compare this against the bundled SDK version reported by the plugin.`;
  }

  private setupStateAckHandler(): void {
    if (!this.bridge) return;

    const unsubscribe = this.bridge.onPluginMessage(
      "runtime.ack",
      (message) => {
        const basis = this.sequenceToBasis.get(message.sequence);
        const gameVersion = basis?.version;
        this.logger.log("[Gateway] Received runtime ack:", message.sequence);
        // Tier-0 perf: mark `t7_state_sync_received` using the plugin's
        // own `Date.now()` captured at gameplay-frame receipt. Uses the
        // syncId -> actionId map populated at t5.
        if (
          typeof gameVersion === "number" &&
          typeof message.clientReceivedAtMs === "number"
        ) {
          const actionId = findActionIdBySyncId(gameVersion);
          if (actionId) {
            recordMark(actionId, PERF_MARK_NAMES.T7_STATE_SYNC_RECEIVED, {
              timestampMs: message.clientReceivedAtMs,
              extra: { syncId: gameVersion, source: "plugin" },
            });
          }
        }
        if (
          typeof gameVersion === "number" &&
          typeof message.clientRenderedAtMs === "number"
        ) {
          const actionId = findActionIdBySyncId(gameVersion);
          if (actionId) {
            recordMark(actionId, PERF_MARK_NAMES.T8_RENDER_COMMIT, {
              timestampMs: message.clientRenderedAtMs,
              extra: { syncId: gameVersion, source: "plugin" },
            });
          }
        }
        if (typeof gameVersion === "number") {
          this.gameSessionStore?.onStateAck(gameVersion, basis);
        }
      },
    );

    this.unsubscribeHandlers.push(unsubscribe);
  }

  private handleError(error: Error): void {
    if (this.state === "error") {
      return;
    }
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    if (this.initStartTimeout) {
      clearTimeout(this.initStartTimeout);
      this.initStartTimeout = null;
    }
    this.clearInitRetryInterval();
    this.logger.error("[Gateway] Error:", error);
    this.state = "error";
    this.config.onError(error);
  }

  private sendSubmitResult(result: InteractionResult): void {
    this.bridge?.sendSubmitResult(result);
  }

  private describeSubmissionFailure(
    error: unknown,
    fallbackMessage: string,
  ): {
    accepted: false;
    errorCode: string;
    message: string;
  } {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "errorCode" in error &&
      typeof error.errorCode === "string"
        ? error.errorCode
        : "submission-error";
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : fallbackMessage;
    return {
      accepted: false,
      errorCode,
      message,
    };
  }

  private currentPluginSessionDescriptor(): PluginSessionDescriptor {
    return {
      sessionId: this.config.sessionId,
      players: this.config.controllablePlayerIds.map((playerId) => ({
        playerId,
        displayName: playerId,
      })),
    };
  }
}
