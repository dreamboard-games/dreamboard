import {
  PluginSessionGateway,
  type HostSessionTransport,
  type LoggerLike,
  type SessionContext,
  type UnifiedSessionStore,
  unifiedSessionSelectors,
} from "@dreamboard-games/ui-host-runtime/runtime";
import { formatConsoleArgs } from "./dev-diagnostics.js";
import type { ActiveSession, DevHostStorage } from "./dev-host-storage.js";
import { toGameSessionStoreApi } from "./ui-host-runtime-contract.js";

const AUTO_RECOVERY_SSE_FAILURE_THRESHOLD = 2;
const MAX_AUTO_RECOVERY_ATTEMPTS = 1;
type DevHostSessionSnapshot = Awaited<
  ReturnType<NonNullable<HostSessionTransport["createDevSessionSnapshot"]>>
>;

type SessionStoreApi = {
  getState: () => UnifiedSessionStore;
  subscribe: (
    listener: (
      state: UnifiedSessionStore,
      previousState: UnifiedSessionStore,
    ) => void,
  ) => () => void;
};

function hasRenderableSnapshot(store: SessionStoreApi): boolean {
  const state = store.getState();
  return (
    unifiedSessionSelectors.bootstrapStatus(state) === "renderable" &&
    state.getPluginSnapshot().view !== null
  );
}

function createSubmissionError(
  errorCode: string | undefined,
  message: string | undefined,
  fallbackMessage: string,
): Error & { errorCode?: string } {
  const error = new Error(message ?? fallbackMessage) as Error & {
    errorCode?: string;
  };
  error.name = "SubmissionError";
  error.errorCode = errorCode;
  return error;
}

export interface DevHostControllerConfig {
  autoStartGame: boolean;
  compiledResultId: string;
  createDevSessionSnapshot?: NonNullable<
    HostSessionTransport["createDevSessionSnapshot"]
  >;
  debug: boolean;
  fallbackSession: ActiveSession;
  projectId: string;
  initialPlayerId?: string | null;
  playerCount: number;
  setupProfileId: string | null;
  slug: string;
  userId: string | null;
}

/**
 * Structured surface for reducer/runtime failures that bubble up from the
 * backend. These are shown in the dev host overlay so authors see the same
 * file/line/stack information they'd get from a `dreamboard dev` backend log.
 */
export interface DevHostRuntimeError {
  title: string;
  summary: string;
  violations: Array<{
    message: string;
    field?: string;
    code?: string;
  }>;
  correlationId?: string;
}

export interface DevHostControllerSnapshot {
  session: ActiveSession;
  seedValue: string;
  isCreatingSession: boolean;
  iframeSrc: string;
  pluginReady: boolean;
  runtimeError: DevHostRuntimeError | null;
}

export class DevHostController {
  private readonly listeners = new Set<() => void>();
  private readonly defaultSession: ActiveSession;
  private readonly unsubscribeStore: () => void;

  private currentSession: ActiveSession;
  private seedValue: string;
  private isCreatingSession = false;
  private pluginReady = false;
  private iframeLoaded = false;
  private iframe: HTMLIFrameElement | null = null;
  private gateway: PluginSessionGateway | null = null;
  private gatewayStoreAttached = false;
  private pluginFrameReloadCounter = 0;
  private autoRecoveryAttempts = 0;
  private sessionSnapshotSseFailureCount = 0;
  private recoveryInFlight = false;
  private runtimeError: DevHostRuntimeError | null = null;
  private playerSwitchRequestId = 0;

  constructor(
    private readonly store: SessionStoreApi,
    private readonly storage: DevHostStorage,
    private readonly config: DevHostControllerConfig,
    private readonly logger: LoggerLike,
  ) {
    this.defaultSession = structuredClone(config.fallbackSession);
    this.currentSession = structuredClone(this.defaultSession);
    this.seedValue = String(this.currentSession.seed ?? 1337);
    this.unsubscribeStore = this.store.subscribe((state) => {
      if (unifiedSessionSelectors.bootstrapStatus(state) !== "loading") {
        this.sessionSnapshotSseFailureCount = 0;
      }
      if (
        this.pluginReady &&
        !this.gatewayStoreAttached &&
        hasRenderableSnapshot(this.store)
      ) {
        this.attachStore();
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): DevHostControllerSnapshot {
    return {
      session: this.currentSession,
      seedValue: this.seedValue,
      isCreatingSession: this.isCreatingSession,
      iframeSrc: `/plugin.html?session=${encodeURIComponent(this.currentSession.sessionId)}&reload=${this.pluginFrameReloadCounter}`,
      pluginReady: this.pluginReady,
      runtimeError: this.runtimeError,
    };
  }

  dismissRuntimeError(): void {
    if (this.runtimeError === null) {
      return;
    }
    this.runtimeError = null;
    this.notify();
  }

  /**
   * Public entry point for surfacing runtime errors originating outside
   * the controller (e.g. the api-client interceptor that detects a
   * `session_invalid` envelope from the dev proxy and wants to route
   * the failure through the existing overlay).
   */
  reportRuntimeError(error: DevHostRuntimeError): void {
    this.setRuntimeError(error);
  }

  async initialize(): Promise<void> {
    this.sessionSnapshotSseFailureCount = 0;
    this.notify();

    try {
      const preferredPlayerId = this.resolvePreferredPlayerId();
      await this.loadStoreSnapshot(preferredPlayerId, "dev-bootstrap");
      this.syncCurrentSessionFromStore();
      this.persistCurrentPlayerFromStore();
    } catch (initialError) {
      const preferredPlayerId = this.resolvePreferredPlayerId();
      let error = initialError;
      if (preferredPlayerId) {
        this.logger.warn(
          "[DevHost] Failed to bootstrap the requested player selection; retrying with the default player:",
          formatErrorForLog(error),
        );
        this.storage.persistPreferredPlayerId(null);
        try {
          await this.loadStoreSnapshot(null, "dev-bootstrap");
          this.syncCurrentSessionFromStore();
          this.persistCurrentPlayerFromStore();
          this.notify();
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      this.logger.error(
        "[DevHost] Failed to bootstrap the backend session:",
        formatErrorForLog(error),
      );
      this.setRuntimeError(
        convertProblemDetailsToRuntimeError(
          error,
          "Failed to bootstrap the backend session.",
        ),
      );
    }
    this.notify();
  }

  setSeedValue(value: string): void {
    this.seedValue = value;
    this.notify();
  }

  async createNewSession(): Promise<void> {
    const nextSeed = Number.parseInt(this.seedValue.trim(), 10);
    if (!Number.isSafeInteger(nextSeed)) {
      this.logger.error("[DevHost] Seed must be a safe integer.");
      return;
    }

    this.isCreatingSession = true;
    this.notify();

    try {
      this.clearRuntimeError();
      if (this.gateway) {
        this.gateway.disconnect();
        this.gateway = null;
      }
      this.gatewayStoreAttached = false;
      this.pluginReady = false;
      this.reloadPluginFrame();
      this.store.getState().reset();
      const snapshot = await this.createBackendDevSessionSnapshot(nextSeed);
      this.adoptCreatedSession(snapshot, nextSeed);
      await this.loadStoreSnapshot(null, "dev-new");
      this.syncCurrentSessionFromStore(nextSeed);
      this.persistCurrentPlayerFromStore();
    } catch (error) {
      this.logger.error("[DevHost] Failed to create a new session:", error);
    } finally {
      this.isCreatingSession = false;
      this.notify();
    }
  }

  async startGameFromSidebar(): Promise<void> {
    try {
      this.clearRuntimeError();
      await this.store.getState().startSession({
        sessionId: this.currentSession.sessionId,
        userId: this.config.userId,
        source: "dev-bootstrap",
      });
      this.syncCurrentSessionFromStore();
      this.persistCurrentPlayerFromStore();
      this.notify();
    } catch (error) {
      this.setRuntimeError(
        convertProblemDetailsToRuntimeError(
          error,
          "Failed to start the backend session.",
        ),
      );
      this.logger.error(
        "[DevHost] Failed to start the backend session:",
        formatErrorForLog(error),
      );
    }
  }

  switchPlayer(playerId: string): void {
    void this.switchPlayerFromBootstrap(playerId);
  }

  async restoreHistoryEntry(entryId: string): Promise<void> {
    await this.store.getState().restoreHistory({
      sessionId: this.currentSession.sessionId,
      entryId,
    });
  }

  setIframe(element: HTMLIFrameElement | null): void {
    this.iframe = element;
  }

  onIframeLoad(): void {
    this.iframeLoaded = true;
    this.connectGateway();
  }

  matchesPluginWindow(source: MessageEvent["source"]): boolean {
    return Boolean(this.iframe && source === this.iframe.contentWindow);
  }

  handleSseTransportError(args: unknown[]): void {
    if (
      unifiedSessionSelectors.bootstrapStatus(this.store.getState()) !==
        "loading" ||
      this.recoveryInFlight
    ) {
      return;
    }

    const errorMessage = args
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(" ");
    if (!errorMessage.includes("SSE failed: 400")) {
      return;
    }

    this.sessionSnapshotSseFailureCount += 1;
    if (
      this.sessionSnapshotSseFailureCount < AUTO_RECOVERY_SSE_FAILURE_THRESHOLD
    ) {
      return;
    }

    void this.recoverFromUnhealthySession(
      "The current session stream is unhealthy, creating a fresh session...",
    );
  }

  dispose(): void {
    this.unsubscribeStore();
    if (this.gateway) {
      this.gateway.disconnect();
      this.gateway = null;
    }
    this.gatewayStoreAttached = false;
    this.store.getState().closeStreams();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private setRuntimeError(error: DevHostRuntimeError): void {
    this.runtimeError = error;
    this.notify();
  }

  private clearRuntimeError(): void {
    if (this.runtimeError === null) {
      return;
    }
    this.runtimeError = null;
    this.notify();
  }

  private connectGateway(): void {
    if (!this.iframeLoaded || !this.iframe) {
      return;
    }

    if (!unifiedSessionSelectors.sessionId(this.store.getState())) {
      return;
    }

    const session = this.store.getState().getPluginSnapshot().session;

    if (this.gateway) {
      this.gateway.disconnect();
      this.gateway = null;
    }
    this.gatewayStoreAttached = false;

    this.pluginReady = false;

    this.gateway = new PluginSessionGateway({
      iframe: this.iframe,
      sessionId: this.currentSession.sessionId,
      controllablePlayerIds: session.controllablePlayerIds,
      controllingPlayerId: session.controllingPlayerId ?? "",
      userId: this.config.userId,
      onReady: () => {
        this.pluginReady = true;
        if (hasRenderableSnapshot(this.store)) {
          this.attachStore();
        }
        this.notify();
      },
      onError: (error) => {
        this.pluginReady = false;
        this.logger.error(
          "[DevHost] Plugin iframe failed:",
          error instanceof Error ? error.message : error,
        );
        this.notify();
      },
      onInteraction: async (
        playerId: string,
        interactionId: string,
        params: unknown,
        meta,
      ) => {
        try {
          await this.store.getState().submitInteraction({
            sessionId: this.currentSession.sessionId,
            playerId,
            interactionId,
            params,
            clientActionId: meta?.clientActionId,
          });
        } catch (error) {
          if (error instanceof Error && error.name === "SubmissionError") {
            throw error;
          }
          throw createSubmissionError(
            "api-error",
            undefined,
            "Failed to submit interaction",
          );
        }
      },
      onValidateInteraction: async (
        playerId: string,
        interactionId: string,
        params: unknown,
      ) => {
        const gameplay = this.store.getState().getRenderableGameplay();
        if (!gameplay) {
          return {
            valid: false,
            errorCode: "runtime-unavailable",
            message: "No renderable gameplay snapshot is available.",
          };
        }
        void playerId;
        void interactionId;
        void params;
        return { valid: true };
      },
      logger: this.logger,
    });

    this.gateway.connect();
  }

  private attachStore(): void {
    if (!this.gateway || this.gatewayStoreAttached) {
      return;
    }

    this.gateway.attachStore(toGameSessionStoreApi(this.store));
    this.gatewayStoreAttached = true;
  }

  private reloadPluginFrame(): void {
    this.pluginFrameReloadCounter += 1;
    this.iframeLoaded = false;
    this.pluginReady = false;
    this.gatewayStoreAttached = false;
  }

  private async recoverFromUnhealthySession(reason: string): Promise<void> {
    if (
      this.recoveryInFlight ||
      this.autoRecoveryAttempts >= MAX_AUTO_RECOVERY_ATTEMPTS ||
      unifiedSessionSelectors.bootstrapStatus(this.store.getState()) !==
        "loading"
    ) {
      return;
    }

    this.recoveryInFlight = true;
    this.autoRecoveryAttempts += 1;

    try {
      this.logger.warn("[DevHost] " + reason);
      const seed = this.currentSession.seed ?? 1337;
      const snapshot = await this.createBackendDevSessionSnapshot(seed);
      this.adoptCreatedSession(snapshot, seed);
      await this.loadStoreSnapshot(null, "dev-new");
      this.syncCurrentSessionFromStore(seed);
      this.persistCurrentPlayerFromStore();
    } catch (error) {
      this.logger.error(
        "[DevHost] Automatic recovery failed:",
        formatConsoleArgs([error]),
      );
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private async loadStoreSnapshot(
    playerId: string | null | undefined,
    source: string,
    expectedPerspectivePlayerId?: string | null,
  ): Promise<void> {
    await this.store.getState().loadSessionSnapshot({
      sessionId: this.currentSession.sessionId,
      userId: this.config.userId,
      requestedPlayerId: playerId,
      expectedPerspectivePlayerId,
      source,
    });
  }

  private async createBackendDevSessionSnapshot(
    seed: number,
  ): Promise<DevHostSessionSnapshot> {
    if (!this.config.createDevSessionSnapshot) {
      throw new Error("Dev host session transport is not configured.");
    }
    return this.config.createDevSessionSnapshot({ seed });
  }

  private adoptCreatedSession(
    snapshot: DevHostSessionSnapshot,
    seed: number | null,
  ): void {
    this.currentSession = {
      sessionId: snapshot.context.sessionId,
      shortCode: snapshot.context.shortCode,
      projectId: this.config.projectId,
      seed,
    };
  }

  private resolvePreferredPlayerId(): string | null {
    return (
      this.config.initialPlayerId?.trim() ||
      this.storage.loadPreferredPlayerId()
    );
  }

  private syncCurrentSessionFromStore(seedOverride?: number | null): void {
    const context = unifiedSessionSelectors.sessionContext(
      this.store.getState(),
    ) as SessionContext | null;
    if (!context) {
      return;
    }
    this.currentSession = {
      sessionId: context.identity.sessionId,
      shortCode: context.identity.shortCode,
      projectId: context.identity.projectId,
      seed: seedOverride ?? this.currentSession.seed ?? null,
    };
    this.seedValue = String(this.currentSession.seed ?? 1337);
    if (this.iframeLoaded) {
      this.connectGateway();
    }
  }

  private persistCurrentPlayerFromStore(): void {
    const currentPlayerId = unifiedSessionSelectors.currentPlayerId(
      this.store.getState(),
    );
    if (currentPlayerId) {
      this.storage.persistPreferredPlayerId(currentPlayerId);
    }
  }

  private async switchPlayerFromBootstrap(playerId: string): Promise<void> {
    const requestId = ++this.playerSwitchRequestId;
    try {
      await this.loadStoreSnapshot(playerId, "player-switch", playerId);
      if (requestId !== this.playerSwitchRequestId) {
        return;
      }
      this.assertSwitchStoreMatchesPlayer(playerId);
      this.clearRuntimeError();
      this.syncCurrentSessionFromStore();
      this.persistCurrentPlayerFromStore();
      this.notify();
    } catch (error) {
      if (requestId !== this.playerSwitchRequestId) {
        return;
      }
      this.logger.error(
        "[DevHost] Failed to switch player:",
        formatErrorForLog(error),
      );
      this.setRuntimeError(
        convertProblemDetailsToRuntimeError(
          error,
          `Failed to switch to ${playerId}.`,
        ),
      );
    }
  }

  private assertSwitchStoreMatchesPlayer(playerId: string): void {
    const currentPlayerId = unifiedSessionSelectors.currentPlayerId(
      this.store.getState(),
    );
    if (!currentPlayerId) {
      return;
    }
    if (currentPlayerId !== playerId) {
      throw new Error(
        `Switch snapshot resolved ${currentPlayerId} instead of ${playerId}.`,
      );
    }
  }
}

function formatErrorForLog(error: unknown): string {
  return error instanceof Error ? error.message : formatConsoleArgs([error]);
}

type ApiErrorPayload = {
  error?: string;
  message?: string;
  title?: string;
  detail?: string;
  status?: number;
  requestId?: string;
  violations?: Array<{
    message?: string;
    field?: string;
    code?: string;
  }>;
};

/**
 * Convert a backend `ProblemDetails` (or an opaque error object) into the
 * structured shape the dev host overlay renders. We surface every violation
 * intentionally — when a reducer `initialize` throws, the JS stack lives in
 * the second violation entry, so collapsing them into a single string would
 * lose the file and line information we just went to the trouble of
 * preserving in `JsExecutor.jsRejectionToException`.
 */
function convertProblemDetailsToRuntimeError(
  error: unknown,
  fallbackMessage: string,
): DevHostRuntimeError {
  const payload = (error ?? {}) as ApiErrorPayload;
  const violations = (payload.violations ?? [])
    .filter((violation) => typeof violation?.message === "string")
    .map((violation) => ({
      message: violation.message as string,
      field: typeof violation.field === "string" ? violation.field : undefined,
      code: typeof violation.code === "string" ? violation.code : undefined,
    }));

  const title =
    payload.title?.trim() ||
    (payload.error === "session_invalid" ? "Session expired" : "") ||
    "Game failed to start";
  const summary =
    payload.detail?.trim() ||
    payload.message?.trim() ||
    (error instanceof Error ? error.message : fallbackMessage);

  return {
    title,
    summary,
    violations,
    correlationId: payload.requestId,
  };
}
