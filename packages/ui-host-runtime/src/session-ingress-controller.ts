import type { StoreApi } from "zustand/vanilla";
import type { SubmitInteractionCommand } from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { SessionControlSnapshot } from "@dreamboard-games/api-client";
import type { LoggerLike } from "./logger.js";
import {
  PERF_MARK_NAMES,
  correlateSyncId,
  findActionIdByVersion,
  recordMark,
} from "./perf.js";
import type { GameplayConnection } from "./gameplay-connection.js";
import type { LobbyApi } from "./lobby-api.js";
import { normalizeEvent, normalizeSnapshot } from "./session-ingress.js";
import type { HostSessionWireEvent } from "./session-ingress.js";
import { getSessionRecoveryDetails } from "./session-recovery.js";
import {
  getGameplayViewport,
  getSessionContext,
  resolveControllablePlayerIds,
} from "./session-model.js";
import {
  createInitialUnifiedSessionState,
  reduceSessionState,
  type SessionStateEffect,
  type SessionStateIngress,
  type SessionStateReducerEnvironment,
  type UnifiedSessionState,
} from "./session-state-reducer.js";

export interface SessionIngressControllerActions {
  loadSessionByShortCode: (input: {
    shortCode: string;
    userId?: string | null;
    requestedPlayerId?: string | null;
    source?: string;
  }) => Promise<void>;
  loadSessionSnapshot: (input: {
    sessionId: string;
    userId?: string | null;
    requestedPlayerId?: string | null;
    expectedPerspectivePlayerId?: string | null;
    source?: string;
  }) => Promise<void>;
  startSession: (input: {
    sessionId: string;
    userId?: string | null;
    source?: string;
  }) => Promise<void>;
  applySessionControlSnapshot: (input: {
    snapshot: SessionControlSnapshot;
    userId?: string | null;
    source?: string;
  }) => void;
  submitInteraction: (command: SubmitInteractionCommand) => Promise<void>;
  restoreHistory: (input: {
    sessionId: string;
    targetVersion: number;
  }) => Promise<void>;
  selectPlayer: (playerId: string) => void;
  clearConnectionError: () => void;
  enqueueActionRejected: (reason: string, targetPlayer?: string) => void;
  closeStreams: () => void;
  onStateAck: (syncId: number) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
  dismissHostFeedback: (id: string) => void;
  clearHostFeedback: () => void;
  clearGameplayLogs: () => void;
  clearSessionEvents: () => void;
  reset: () => void;
}

export interface CreateSessionIngressControllerOptions<
  TStore extends UnifiedSessionState,
> {
  store: StoreApi<TStore>;
  lobbyApi: LobbyApi;
  gameplayConnection: GameplayConnection;
  logger: LoggerLike;
  fallbackToAllSeatsWhenUserIdMissing: boolean;
  reducerEnvironment: SessionStateReducerEnvironment;
}

function describeLiveStreamError(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message.includes("429") ||
      error.message.includes("400 Bad Request")
    ) {
      return "Too many live views are open for this session. Close unused tabs or devices, then refresh.";
    }
    return "Live session updates disconnected. Check your network and refresh to reconnect.";
  }
  return "Live session updates disconnected. Refresh to reconnect.";
}

function describeCommandFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const payload = error as { detail?: unknown; message?: unknown } | null;
  if (typeof payload?.detail === "string" && payload.detail.trim()) {
    return payload.detail;
  }
  if (typeof payload?.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

function createSubmissionError(
  errorCode: string | undefined,
  message: string | undefined,
): Error & { errorCode?: string } {
  const error = new Error(message ?? "Interaction rejected") as Error & {
    errorCode?: string;
  };
  error.name = "SubmissionError";
  error.errorCode = errorCode;
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionIngressController<
  TStore extends UnifiedSessionState,
>(
  options: CreateSessionIngressControllerOptions<TStore>,
): SessionIngressControllerActions {
  const {
    store,
    lobbyApi,
    gameplayConnection,
    logger,
    fallbackToAllSeatsWhenUserIdMissing,
    reducerEnvironment,
  } = options;

  const dispatchIngress = (ingress: SessionStateIngress) => {
    const { state, effects } = reduceSessionState(
      store.getState(),
      ingress,
      reducerEnvironment,
    );
    store.setState(state as Partial<TStore>);
    effects.forEach(executeEffect);
  };

  let connectedSessionId: string | null = null;

  const onLiveMessage = (message: HostSessionWireEvent) => {
    const state = store.getState();
    const context = getSessionContext(state.session);
    const event = normalizeEvent(message, {
      currentContext: context,
      currentGameplay: getGameplayViewport(state.session),
      userId: context?.userId ?? null,
    });
    dispatchIngress({
      type: "event.received",
      source: "live",
      event,
      debugEvent: { eventType: message.type, data: message },
    });
  };

  const gameplayHandlers = {
    onStateChange: (state: GameplayConnection["state"]) => {
      dispatchIngress({
        type: "connection.changed",
        channel: "gameplay",
        connected: state === "open",
      });
    },
    onError: (error: unknown) => {
      logger.error("[UnifiedSession] live connection error:", error);
      dispatchIngress({
        type: "connection.failed",
        message: describeLiveStreamError(error),
      });
    },
    onRecovering: (details: {
      message: string;
      retryAfterMs: number;
      attempt: number;
    }) => {
      dispatchIngress({
        type: "connection.recovering",
        message: details.message,
        retryAfterMs: details.retryAfterMs,
        attempt: details.attempt,
      });
    },
    onEvent: onLiveMessage,
  };

  const closeGameplayConnection = () => {
    gameplayConnection.close();
    connectedSessionId = null;
    dispatchIngress({
      type: "connection.changed",
      channel: "gameplay",
      connected: false,
    });
  };

  function executeEffect(effect: SessionStateEffect): void {
    switch (effect.type) {
      case "requestGameplayResync": {
        const context = getSessionContext(store.getState().session);
        if (!context) {
          gameplayHandlers.onError(
            new Error("Cannot resync gameplay without session context"),
          );
          break;
        }
        logger.warn(
          `[UnifiedSession] ${effect.reason}; reconnecting to refresh gameplay.bootstrap`,
        );
        void gameplayConnection.connect({
          sessionId: effect.sessionId,
          websocketUrl: context.gameplayWebsocketUrl,
          playerId: effect.playerId,
          switchablePlayerIds: context.switchablePlayerIds,
          handlers: gameplayHandlers,
        });
        break;
      }
      case "reconnectGameplay":
        void gameplayConnection
          .switchPerspective(effect.playerId)
          .catch((error) => gameplayHandlers.onError(error));
        break;
      case "perf.storeApplied": {
        const actionId = findActionIdByVersion(effect.gameplayVersion);
        if (!actionId) break;
        recordMark(actionId, PERF_MARK_NAMES.T5_STORE_APPLIED, {
          extra: {
            version: effect.gameplayVersion,
            syncId: effect.syncId,
          },
        });
        correlateSyncId(actionId, effect.syncId);
        break;
      }
      case "log.warn":
        logger.warn(effect.message);
        break;
    }
  }

  function prepareSessionConnection(userId: string | null) {
    const context = getSessionContext(store.getState().session);
    const controllablePlayerIds = context
      ? resolveControllablePlayerIds(
          context.switchablePlayerIds,
          context.seats,
          userId,
          fallbackToAllSeatsWhenUserIdMissing,
        )
      : [];
    dispatchIngress({
      type: "connection.prepared",
      userId,
      switchablePlayerIds: controllablePlayerIds,
    });
  }

  function connectLiveSession(
    sessionId: string,
    userId: string | null,
    connectOptions: { source?: string; playerId: string },
  ) {
    prepareSessionConnection(userId);
    logger.log(`[UnifiedSession] Connecting to session: ${sessionId}`);
    const context = getSessionContext(store.getState().session);
    if (!context) {
      gameplayHandlers.onError(
        new Error("Cannot connect gameplay without session context"),
      );
      return;
    }
    connectedSessionId = sessionId;
    void gameplayConnection.connect({
      sessionId,
      websocketUrl: context.gameplayWebsocketUrl,
      playerId: connectOptions.playerId,
      switchablePlayerIds: context.switchablePlayerIds,
      handlers: gameplayHandlers,
    });
  }

  async function runSnapshotCommand(
    input: {
      target?: { sessionId?: string; shortCode?: string };
      sourceLabel: "short-code" | "snapshot" | "start" | "dev-new";
      connectSource?: string;
      userId?: string | null;
      expectedPerspectivePlayerId?: string | null;
      preserveCurrentOnFailure?: boolean;
      load: () => Promise<Awaited<ReturnType<LobbyApi["load"]>>>;
    },
    failureMessage: string,
  ): Promise<void> {
    if (!input.preserveCurrentOnFailure) {
      dispatchIngress({ type: "command.loading", target: input.target });
    }
    let recoveryAttempt = 0;
    while (true) {
      try {
        const snapshot = await input.load();
        const normalized = normalizeSnapshot(snapshot, {
          userId: input.userId ?? null,
        });
        dispatchIngress({
          type: "snapshot.loaded",
          source: input.sourceLabel,
          snapshot: normalized,
          expectedPerspectivePlayerId: input.expectedPerspectivePlayerId,
        });
        if (normalized.type === "started") {
          const playerId = normalized.preferredPlayerId;
          if (!playerId) {
            throw new Error(
              "Started session has no authorized gameplay perspective.",
            );
          }
          connectLiveSession(
            normalized.context.identity.sessionId,
            input.userId ?? null,
            {
              source: input.connectSource,
              playerId,
            },
          );
        } else if (normalized.type === "lobby") {
          closeGameplayConnection();
          prepareSessionConnection(input.userId ?? null);
        } else {
          closeGameplayConnection();
          prepareSessionConnection(input.userId ?? null);
        }
        return;
      } catch (error) {
        const recovery = getSessionRecoveryDetails(error);
        if (recovery && recoveryAttempt < 60) {
          recoveryAttempt += 1;
          dispatchIngress({
            type: "connection.recovering",
            message: recovery.message,
            retryAfterMs: recovery.retryAfterMs,
            attempt: recoveryAttempt,
          });
          await sleep(recovery.retryAfterMs);
          continue;
        }
        if (!input.preserveCurrentOnFailure) {
          dispatchIngress({
            type: "command.failed",
            message: describeCommandFailure(error, failureMessage),
          });
        }
        throw error;
      }
    }
  }

  return {
    applySessionControlSnapshot: (input) => {
      const normalized = normalizeSnapshot(input.snapshot, {
        userId: input.userId ?? null,
      });
      dispatchIngress({
        type: "snapshot.loaded",
        source: "snapshot",
        snapshot: normalized,
      });
      if (normalized.type === "started" && normalized.preferredPlayerId) {
        connectLiveSession(
          normalized.context.identity.sessionId,
          input.userId ?? null,
          {
            source: input.source ?? "lobby-snapshot",
            playerId: normalized.preferredPlayerId,
          },
        );
      } else {
        closeGameplayConnection();
        prepareSessionConnection(input.userId ?? null);
      }
    },
    loadSessionByShortCode: async (input) => {
      await runSnapshotCommand(
        {
          target: { shortCode: input.shortCode },
          sourceLabel: "short-code",
          connectSource: input.source,
          userId: input.userId,
          load: () =>
            lobbyApi.loadByShortCode({
              shortCode: input.shortCode,
              requestedPlayerId: input.requestedPlayerId,
            }),
        },
        "Failed to load session by short code.",
      );
    },
    loadSessionSnapshot: async (input) => {
      await runSnapshotCommand(
        {
          target: { sessionId: input.sessionId },
          sourceLabel: input.source === "dev-new" ? "dev-new" : "snapshot",
          connectSource: input.source,
          userId: input.userId,
          expectedPerspectivePlayerId: input.expectedPerspectivePlayerId,
          preserveCurrentOnFailure: input.source === "player-switch",
          load: () =>
            lobbyApi.load({
              sessionId: input.sessionId,
              requestedPlayerId: input.requestedPlayerId,
            }),
        },
        "Failed to load session snapshot.",
      );
    },
    startSession: async (input) => {
      await runSnapshotCommand(
        {
          target: { sessionId: input.sessionId },
          sourceLabel: "start",
          connectSource: input.source,
          userId: input.userId,
          load: () => lobbyApi.start({ sessionId: input.sessionId }),
        },
        "Failed to start session.",
      );
    },
    submitInteraction: async (command) => {
      const gameplay = getGameplayViewport(store.getState().session);
      if (!gameplay) {
        throw new Error("No renderable gameplay snapshot is available.");
      }
      const context = getSessionContext(store.getState().session);
      if (!context) {
        throw new Error("No session context is available.");
      }
      if (
        command.basis.version !== gameplay.version ||
        command.basis.actionSetVersion !== gameplay.actionSetVersion ||
        command.basis.perspectivePlayerId !==
          gameplay.canonicalFrame?.basis.perspectivePlayerId
      ) {
        throw createSubmissionError(
          "stale-frame",
          "Interaction was created from a stale gameplay frame.",
        );
      }
      recordMark(command.clientActionId, PERF_MARK_NAMES.T2_HTTP_SENT, {
        extra: {
          playerId: command.basis.perspectivePlayerId,
          interactionId: command.interactionId,
          expectedVersion: gameplay.version,
        },
      });
      let response: Awaited<ReturnType<GameplayConnection["submit"]>> | null =
        null;
      let recoveryAttempt = 0;
      while (!response) {
        try {
          response = await gameplayConnection.submit(command);
        } catch (error) {
          const recovery = getSessionRecoveryDetails(error);
          if (recovery && recoveryAttempt < 60) {
            recoveryAttempt += 1;
            dispatchIngress({
              type: "connection.recovering",
              message: recovery.message,
              retryAfterMs: recovery.retryAfterMs,
              attempt: recoveryAttempt,
            });
            await sleep(recovery.retryAfterMs);
            continue;
          }
          const message = describeCommandFailure(error, "Interaction rejected");
          dispatchIngress({
            type: "feedback.actionRejected",
            reason: message,
            targetPlayer: command.basis.perspectivePlayerId,
          });
          throw createSubmissionError("api-error", message);
        }
      }
      recordMark(command.clientActionId, PERF_MARK_NAMES.T3_HTTP_RESPONSE, {
        extra: {
          accepted: response.accepted,
          errorCode: response.accepted ? undefined : response.errorCode,
          transport: "ok",
        },
      });
      if (response.accepted) {
        return;
      }
      dispatchIngress({
        type: "feedback.actionRejected",
        reason: response.message ?? "Interaction rejected",
        targetPlayer: command.basis.perspectivePlayerId,
      });
      throw createSubmissionError(
        response.errorCode,
        response.message ?? "Interaction rejected",
      );
    },
    restoreHistory: async (input) => {
      await gameplayConnection.restoreHistory(input);
    },
    selectPlayer: (playerId) => {
      const session = store.getState().session;
      const currentPlayerId =
        session.type === "gameplay"
          ? session.perspective.playerId
          : session.type === "gameplayLoading"
            ? session.requestedPlayerId
            : null;
      if (playerId === currentPlayerId) {
        return;
      }
      const context = getSessionContext(session);
      if (!context) return;
      dispatchIngress({
        type: "local.playerSelected",
        playerId,
        sessionId: connectedSessionId ?? context.identity.sessionId,
      });
    },
    clearConnectionError: () =>
      dispatchIngress({ type: "connection.errorCleared" }),
    enqueueActionRejected: (reason, targetPlayer) =>
      dispatchIngress({
        type: "feedback.actionRejected",
        reason,
        targetPlayer,
      }),
    closeStreams: () => {
      closeGameplayConnection();
      dispatchIngress({ type: "streams.closed" });
    },
    onStateAck: () => dispatchIngress({ type: "activity.stateAcked" }),
    markNotificationRead: (id) =>
      dispatchIngress({ type: "activity.notificationRead", id }),
    clearNotifications: () =>
      dispatchIngress({ type: "activity.notificationsCleared" }),
    dismissHostFeedback: (id) =>
      dispatchIngress({ type: "activity.hostFeedbackDismissed", id }),
    clearHostFeedback: () =>
      dispatchIngress({ type: "activity.hostFeedbackCleared" }),
    clearGameplayLogs: () =>
      dispatchIngress({ type: "activity.gameplayLogsCleared" }),
    clearSessionEvents: () =>
      dispatchIngress({ type: "debug.sessionEventsCleared" }),
    reset: () => {
      closeGameplayConnection();
      store.setState(createInitialUnifiedSessionState() as Partial<TStore>);
    },
  };
}
