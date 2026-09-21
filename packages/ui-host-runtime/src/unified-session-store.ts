import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { StoreApi } from "zustand/vanilla";
import type { PluginGameplayFrame } from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { LoggerLike } from "./logger.js";
import { consoleLogger } from "./logger.js";
import type { GameplayConnection } from "./gameplay-connection.js";
import type { LobbyApi } from "./lobby-api.js";
import type { GameplayLifecycle, GameplayViewport } from "./session-model.js";
import {
  getGameplayViewport,
  getSessionContext,
  resolveControllablePlayerIds,
} from "./session-model.js";
import { createSessionIngressController } from "./session-ingress-controller.js";
import type { SessionIngressControllerActions } from "./session-ingress-controller.js";
import {
  createInitialUnifiedSessionState,
  type UnifiedSessionState,
} from "./session-state-reducer.js";
import {
  selectBootstrapStatus,
  selectGameplayViewModel,
  selectGameplayViewport,
  selectHistory,
  selectLobbyViewModel,
  selectPluginDebugProjection,
  selectPluginGameplayFrame,
  selectSessionContext,
  selectSessionError,
  selectSessionType,
  type HostPluginDebugProjection,
} from "./session-projection.js";

export type {
  GameplayViewport,
  HistoryState,
  SessionContext,
  SessionIdentity,
  SessionPhase,
  UnifiedSessionModel,
} from "./session-model.js";
export type {
  BootstrapStatus,
  GameplayViewModel,
  HostPluginDebugProjection,
  LobbyViewModel,
} from "./session-projection.js";
export type {
  GameplayLogEntry,
  GameplayLogResetReason,
} from "./session-ingress.js";
export type {
  ActivityState,
  ConnectionState,
  ConnectionRecoveryState,
  DebugState,
  HostFeedback,
  HostFeedbackPayload,
  HostFeedbackType,
  Notification,
  NotificationPayload,
  NotificationType,
  SessionEventEntry,
  UnifiedSessionState,
} from "./session-state-reducer.js";

export type GameplayState = GameplayViewport;

export interface UnifiedSessionActions extends SessionIngressControllerActions {
  getPluginSnapshot: () => HostPluginDebugProjection;
  getPluginGameplayFrame: () => PluginGameplayFrame | null;
  getRenderableGameplay: () => GameplayViewport | null;
}

export type UnifiedSessionStore = UnifiedSessionState & UnifiedSessionActions;

export interface CreateUnifiedSessionStoreOptions {
  lobbyApi: LobbyApi;
  gameplayConnection: GameplayConnection;
  logger?: LoggerLike;
  fallbackToAllSeatsWhenUserIdMissing?: boolean;
}

let sessionEventIdCounter = 0;
let notificationIdCounter = 0;
const EMPTY_ARRAY: never[] = [];
const ACTIVE_GAMEPLAY_LIFECYCLE: GameplayLifecycle = { status: "active" };

function generateNotificationId(): string {
  return `notif-${++notificationIdCounter}-${Date.now()}`;
}

export function createUnifiedSessionStore(
  options: CreateUnifiedSessionStoreOptions,
): StoreApi<UnifiedSessionStore> {
  const logger = options.logger ?? consoleLogger;
  const fallbackToAllSeatsWhenUserIdMissing =
    options.fallbackToAllSeatsWhenUserIdMissing ?? false;

  return createStore<UnifiedSessionStore>()(
    subscribeWithSelector((_, get, store) => {
      const controller = createSessionIngressController({
        store,
        lobbyApi: options.lobbyApi,
        gameplayConnection: options.gameplayConnection,
        logger,
        fallbackToAllSeatsWhenUserIdMissing,
        reducerEnvironment: {
          fallbackToAllSeatsWhenUserIdMissing,
          nextEventId: () => ++sessionEventIdCounter,
          nextNotificationId: generateNotificationId,
          nowMs: () => Date.now(),
          nowIso: () => new Date().toISOString(),
        },
      });

      return {
        ...createInitialUnifiedSessionState(),
        ...controller,
        getPluginSnapshot: () =>
          selectPluginDebugProjection(
            get(),
            fallbackToAllSeatsWhenUserIdMissing,
          ),
        getPluginGameplayFrame: () => selectPluginGameplayFrame(get()),
        getRenderableGameplay: () => getGameplayViewport(get().session),
      };
    }),
  );
}

export const unifiedSessionSelectors = {
  sessionType: selectSessionType,
  bootstrapStatus: selectBootstrapStatus,
  sessionContext: selectSessionContext,
  lobby: selectLobbyViewModel,
  gameplay: selectGameplayViewModel,
  gameplayViewport: selectGameplayViewport,
  pluginGameplayFrame: selectPluginGameplayFrame,
  hasGameplayPayload: (s: UnifiedSessionStore) =>
    getGameplayViewport(s.session) !== null,
  history: selectHistory,
  lifecycle: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.lifecycle ?? ACTIVE_GAMEPLAY_LIFECYCLE,
  isConnected: (s: UnifiedSessionStore) => s.connection.isConnected,
  connectionError: (s: UnifiedSessionStore) => s.connection.error,
  connectionRecovery: (s: UnifiedSessionStore) => s.connection.recovery,
  isLoading: (s: UnifiedSessionStore) =>
    s.session.type === "loading" ||
    s.session.type === "gameplayLoading" ||
    s.connection.recovery.active,
  error: selectSessionError,
  sessionId: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.identity.sessionId ?? null,
  shortCode: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.identity.shortCode ?? "",
  projectId: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.identity.projectId ?? null,
  seats: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.seats ?? EMPTY_ARRAY,
  canStart: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.canStart ?? false,
  hostActor: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.hostActor ?? null,
  isSessionHost: (s: UnifiedSessionStore) =>
    selectLobbyViewModel(s)?.isSessionHost ?? false,
  controllablePlayerIds: (s: UnifiedSessionStore) => {
    const context = getSessionContext(s.session);
    return context
      ? resolveControllablePlayerIds(
          context.switchablePlayerIds,
          context.seats,
          context.userId,
        )
      : EMPTY_ARRAY;
  },
  controllingPlayerId: (s: UnifiedSessionStore) =>
    s.session.type === "gameplay" || s.session.type === "ended"
      ? s.session.perspective.playerId
      : null,
  currentPlayerId: (s: UnifiedSessionStore) =>
    s.session.type === "gameplay" || s.session.type === "ended"
      ? s.session.perspective.playerId
      : s.session.type === "gameplayLoading"
        ? s.session.requestedPlayerId
        : s.session.type === "lobby"
          ? s.session.preferredPlayerId
          : null,
  userId: (s: UnifiedSessionStore) =>
    getSessionContext(s.session)?.userId ?? null,
  notifications: (s: UnifiedSessionStore) => s.activity.notifications,
  hostFeedback: (s: UnifiedSessionStore) => s.activity.hostFeedback,
  gameplayLogs: (s: UnifiedSessionStore) => s.activity.gameplayLogs,
  gameplayLogCursor: (s: UnifiedSessionStore) => s.activity.gameplayLogCursor,
  gameplayLogResetReason: (s: UnifiedSessionStore) =>
    s.activity.gameplayLogResetReason,
  sessionEvents: (s: UnifiedSessionStore) => s.debug.sessionEvents,
  syncId: (s: UnifiedSessionStore) => s.activity.syncId,
  activity: (s: UnifiedSessionStore) => s.activity,
  debug: (s: UnifiedSessionStore) => s.debug,
};
