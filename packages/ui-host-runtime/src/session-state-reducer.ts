import type {
  GameplayPerspective,
  GameplayViewport,
  SessionContext,
  UnifiedSessionModel,
} from "./session-model.js";
import {
  gameplayViewportForPlayer,
  getGameplayViewport,
  getSessionContext,
  resolveControllablePlayerIds,
  toHistoryState,
  withContext,
} from "./session-model.js";
import type {
  GameplayLogEntry,
  GameplayLogResetReason,
  NormalizedSessionEvent,
  NormalizedSessionSnapshot,
} from "./session-ingress.js";

export interface GameOutcome {
  reason: {
    code: string;
    message?: string;
  };
  standings: Array<{
    playerId: string;
    rank: number;
    result: "win" | "draw" | "loss" | "eliminated";
    score?: number;
    scoreBreakdown?: Array<{
      id: string;
      label: string;
      value: number;
    }>;
    tieBreaks?: Array<{
      id: string;
      label: string;
      value: number | string;
    }>;
  }>;
}

interface ActivityItemBase<
  TType extends string,
  TPayload extends { type: TType },
> {
  id: string;
  type: TType;
  payload: TPayload;
  timestamp: number;
}

export type Notification =
  | (ActivityItemBase<
      "YOUR_TURN",
      { type: "YOUR_TURN"; activePlayers: string[] }
    > & {
      read: boolean;
    })
  | (ActivityItemBase<
      "PROMPT_OPENED",
      {
        type: "PROMPT_OPENED";
        promptId: string;
        promptInstanceId: string;
        targetPlayer: string;
        title?: string;
      }
    > & { read: boolean })
  | (ActivityItemBase<
      "ACTION_EXECUTED",
      { type: "ACTION_EXECUTED"; playerId: string; actionType: string }
    > & { read: boolean })
  | (ActivityItemBase<
      "ACTION_REJECTED",
      { type: "ACTION_REJECTED"; reason: string; targetPlayer?: string }
    > & { read: boolean })
  | (ActivityItemBase<
      "TURN_CHANGED",
      {
        type: "TURN_CHANGED";
        previousPlayers: string[];
        currentPlayers: string[];
      }
    > & { read: boolean })
  | (ActivityItemBase<
      "STATE_CHANGED",
      { type: "STATE_CHANGED"; newState: string }
    > & {
      read: boolean;
    })
  | (ActivityItemBase<
      "GAME_ENDED",
      {
        type: "GAME_ENDED";
        outcome: GameOutcome;
      }
    > & { read: boolean })
  | (ActivityItemBase<
      "ERROR",
      { type: "ERROR"; message: string; code?: string }
    > & {
      read: boolean;
    });

export type NotificationType = Notification["type"];
export type NotificationPayload = Notification["payload"];

export type HostFeedback =
  | ActivityItemBase<
      "ACTION_REJECTED",
      { type: "ACTION_REJECTED"; reason: string; targetPlayer?: string }
    >
  | ActivityItemBase<
      "PROMPT_OPENED",
      {
        type: "PROMPT_OPENED";
        promptId: string;
        promptInstanceId: string;
        targetPlayer: string;
        title?: string;
      }
    >
  | ActivityItemBase<
      "YOUR_TURN",
      { type: "YOUR_TURN"; activePlayers: string[] }
    >;

export type HostFeedbackType = HostFeedback["type"];
export type HostFeedbackPayload = HostFeedback["payload"];

export interface SessionEventEntry {
  id: number;
  eventType: string;
  data: unknown;
  timestamp: string;
}

export interface ConnectionState {
  lobby: boolean;
  gameplay: boolean;
  error: string | null;
  isConnected: boolean;
  recovery: ConnectionRecoveryState;
}

export interface ConnectionRecoveryState {
  active: boolean;
  message: string | null;
  retryAfterMs: number | null;
  attempt: number | null;
  since: number | null;
}

export interface ActivityState {
  notifications: Notification[];
  hostFeedback: HostFeedback[];
  gameplayLogs: GameplayLogEntry[];
  gameplayLogCursor: number | null;
  gameplayLogResetReason: GameplayLogResetReason | null;
  syncId: number;
  lastSyncTimestamp: number | null;
  lastAckTimestamp: number | null;
}

export interface DebugState {
  sessionEvents: SessionEventEntry[];
  maxEvents: number;
}

export interface UnifiedSessionState {
  session: UnifiedSessionModel;
  connection: ConnectionState;
  activity: ActivityState;
  debug: DebugState;
}

export type SnapshotIngressSource =
  | "short-code"
  | "snapshot"
  | "start"
  | "dev-new";

export type EventIngressSource = "live" | "submit-response";

export type SessionStateIngress =
  | {
      type: "command.loading";
      target?: { sessionId?: string; shortCode?: string };
    }
  | { type: "command.failed"; message: string }
  | {
      type: "snapshot.loaded";
      source: SnapshotIngressSource;
      snapshot: NormalizedSessionSnapshot;
      expectedPerspectivePlayerId?: string | null;
    }
  | {
      type: "event.received";
      source: EventIngressSource;
      event: NormalizedSessionEvent;
      debugEvent?: { eventType: string; data: unknown };
      clientActionId?: string | null;
    }
  | {
      type: "connection.prepared";
      userId: string | null;
      switchablePlayerIds: string[];
    }
  | {
      type: "connection.changed";
      channel: "lobby" | "gameplay";
      connected: boolean;
    }
  | { type: "connection.failed"; message: string }
  | {
      type: "connection.recovering";
      message: string;
      retryAfterMs: number;
      attempt: number;
    }
  | { type: "connection.errorCleared" }
  | {
      type: "feedback.actionRejected";
      reason: string;
      targetPlayer?: string;
    }
  | { type: "local.playerSelected"; playerId: string; sessionId: string }
  | { type: "activity.stateAcked" }
  | { type: "activity.notificationRead"; id: string }
  | { type: "activity.notificationsCleared" }
  | { type: "activity.hostFeedbackDismissed"; id: string }
  | { type: "activity.hostFeedbackCleared" }
  | { type: "activity.gameplayLogsCleared" }
  | { type: "debug.sessionEventsCleared" }
  | { type: "streams.closed" }
  | { type: "session.reset" };

export type SessionStateEffect =
  | {
      type: "requestGameplayResync";
      sessionId: string;
      playerId: string;
      reason: string;
    }
  | {
      type: "reconnectGameplay";
      sessionId: string;
      playerId: string;
      source: "player-switch";
    }
  | {
      type: "perf.storeApplied";
      gameplayVersion: number;
      syncId: number;
    }
  | {
      type: "log.warn";
      message: string;
    };

export interface SessionStateReducerEnvironment {
  fallbackToAllSeatsWhenUserIdMissing: boolean;
  nextEventId: () => number;
  nextNotificationId: () => string;
  nowMs: () => number;
  nowIso: () => string;
}

export interface SessionStateReducerResult {
  state: UnifiedSessionState;
  effects: SessionStateEffect[];
}

export function createInitialUnifiedSessionState(): UnifiedSessionState {
  return {
    session: { type: "idle" },
    connection: {
      lobby: false,
      gameplay: false,
      error: null,
      isConnected: false,
      recovery: {
        active: false,
        message: null,
        retryAfterMs: null,
        attempt: null,
        since: null,
      },
    },
    activity: {
      notifications: [],
      hostFeedback: [],
      gameplayLogs: [],
      gameplayLogCursor: null,
      gameplayLogResetReason: null,
      syncId: 0,
      lastSyncTimestamp: null,
      lastAckTimestamp: null,
    },
    debug: { sessionEvents: [], maxEvents: 500 },
  };
}

function appendSessionEvent(
  state: UnifiedSessionState,
  debugEvent: { eventType: string; data: unknown },
  env: SessionStateReducerEnvironment,
) {
  const newEvent: SessionEventEntry = {
    id: env.nextEventId(),
    eventType: debugEvent.eventType,
    data: debugEvent.data,
    timestamp: env.nowIso(),
  };
  return [...state.debug.sessionEvents, newEvent].slice(-state.debug.maxEvents);
}

function appendBounded<T>(
  values: readonly T[],
  next: T | readonly T[],
  maxLength: number,
): T[] {
  const appended = Array.isArray(next)
    ? [...values, ...next]
    : [...values, next];
  return appended.slice(-maxLength);
}

function createActionRejectedArtifacts(
  reason: string,
  targetPlayer: string | undefined,
  env: SessionStateReducerEnvironment,
) {
  return {
    notification: {
      id: env.nextNotificationId(),
      type: "ACTION_REJECTED" as const,
      payload: { type: "ACTION_REJECTED" as const, reason, targetPlayer },
      timestamp: env.nowMs(),
      read: false,
    },
    hostFeedback: {
      id: env.nextNotificationId(),
      type: "ACTION_REJECTED" as const,
      payload: { type: "ACTION_REJECTED" as const, reason, targetPlayer },
      timestamp: env.nowMs(),
    },
  };
}

function createPromptOpenedArtifacts(
  prompt: {
    interactionId: string;
    context?: { to?: string; title?: string };
  },
  env: SessionStateReducerEnvironment,
) {
  const payload = {
    type: "PROMPT_OPENED" as const,
    promptId: prompt.interactionId,
    promptInstanceId: prompt.interactionId,
    targetPlayer: prompt.context?.to ?? "",
    title: prompt.context?.title ?? undefined,
  };
  return {
    notification: {
      id: env.nextNotificationId(),
      type: "PROMPT_OPENED" as const,
      payload,
      timestamp: env.nowMs(),
      read: false,
    },
    hostFeedback: {
      id: env.nextNotificationId(),
      type: "PROMPT_OPENED" as const,
      payload,
      timestamp: env.nowMs(),
    },
  };
}

function getOpenedPrompts(
  previous: ReadonlyArray<{ kind: string; interactionId: string }>,
  next: ReadonlyArray<{
    kind: string;
    interactionId: string;
    context?: { to?: string; title?: string };
  }>,
) {
  const previousPromptIds = new Set(
    previous
      .filter((descriptor) => descriptor.kind === "prompt")
      .map((prompt) => prompt.interactionId),
  );
  return next.filter(
    (descriptor) =>
      descriptor.kind === "prompt" &&
      !previousPromptIds.has(descriptor.interactionId),
  );
}

function hasBoardStaticHashMismatch(
  gameplay: GameplayViewport | null,
  incomingGameplay: GameplayViewport,
): boolean {
  const incomingHash = incomingGameplay.boardStaticHash ?? null;
  const cachedHash = gameplay?.boardStaticHash ?? null;
  return (
    cachedHash !== null && incomingHash !== null && incomingHash !== cachedHash
  );
}

function hasRenderableGameplayView(gameplay: GameplayViewport): boolean {
  return gameplay.view !== null || gameplay.boardStatic !== null;
}

function shouldIgnoreGameplayUpdate(
  currentGameplay: GameplayViewport | null,
  incomingGameplay: GameplayViewport,
): boolean {
  if (!currentGameplay) return false;
  if (incomingGameplay.version < currentGameplay.version) return true;
  if (incomingGameplay.version > currentGameplay.version) return false;
  if (
    currentGameplay.actionSetVersion.endsWith(":history") &&
    !incomingGameplay.actionSetVersion.endsWith(":history")
  ) {
    return false;
  }
  if (
    !hasRenderableGameplayView(currentGameplay) &&
    hasRenderableGameplayView(incomingGameplay)
  ) {
    return false;
  }
  return true;
}

function applyGameplaySnapshotToState(
  state: UnifiedSessionState,
  gameplay: GameplayViewport,
  context: SessionContext,
  options: {
    nextSyncId: number;
    perspective: GameplayPerspective;
    debugEvent?: { eventType: string; data: unknown };
    env: SessionStateReducerEnvironment;
  },
): UnifiedSessionState {
  const previousGameplay = getGameplayViewport(state.session);
  const promptArtifacts = getOpenedPrompts(
    previousGameplay?.availableInteractions ?? [],
    gameplay.availableInteractions,
  ).map((prompt) => createPromptOpenedArtifacts(prompt, options.env));
  return {
    ...state,
    session:
      context.lifecycle.status === "ended"
        ? {
            type: "ended",
            context,
            perspective: options.perspective,
            gameplay,
          }
        : {
            type: "gameplay",
            context,
            perspective: options.perspective,
            gameplay,
          },
    activity: {
      ...state.activity,
      notifications: [
        ...state.activity.notifications,
        ...promptArtifacts.map((artifact) => artifact.notification),
      ],
      hostFeedback: [
        ...state.activity.hostFeedback,
        ...promptArtifacts.map((artifact) => artifact.hostFeedback),
      ],
      syncId: options.nextSyncId,
      lastSyncTimestamp: options.env.nowMs(),
    },
    debug: {
      ...state.debug,
      sessionEvents: options.debugEvent
        ? appendSessionEvent(state, options.debugEvent, options.env)
        : state.debug.sessionEvents,
    },
    connection: {
      ...state.connection,
      error: null,
      recovery: {
        active: false,
        message: null,
        retryAfterMs: null,
        attempt: null,
        since: null,
      },
    },
  };
}

function assertExpectedPerspectivePlayer(
  snapshot: NormalizedSessionSnapshot,
  expectedPlayerId: string | null | undefined,
) {
  if (!expectedPlayerId || snapshot.type !== "started") {
    return;
  }
  if (snapshot.preferredPlayerId !== expectedPlayerId) {
    throw new Error(
      `Switch snapshot resolved ${snapshot.preferredPlayerId ?? "no player"} instead of ${expectedPlayerId}.`,
    );
  }
}

function reduceSnapshotLoaded(
  state: UnifiedSessionState,
  ingress: Extract<SessionStateIngress, { type: "snapshot.loaded" }>,
  env: SessionStateReducerEnvironment,
): UnifiedSessionState {
  assertExpectedPerspectivePlayer(
    ingress.snapshot,
    ingress.expectedPerspectivePlayerId,
  );
  const context = ingress.snapshot.context;
  const nextSyncId = state.activity.syncId + 1;

  const requestedPlayerId = ingress.snapshot.preferredPlayerId;
  const session: UnifiedSessionModel =
    ingress.snapshot.type === "started" && requestedPlayerId
      ? { type: "gameplayLoading", context, requestedPlayerId }
      : {
          type: "lobby",
          context,
          preferredPlayerId: requestedPlayerId,
        };
  return {
    ...state,
    session,
    activity: {
      ...state.activity,
      syncId: nextSyncId,
      lastSyncTimestamp: env.nowMs(),
    },
    connection: {
      ...state.connection,
      error: null,
      recovery: {
        active: false,
        message: null,
        retryAfterMs: null,
        attempt: null,
        since: null,
      },
    },
  };
}

function reduceEventReceived(
  state: UnifiedSessionState,
  ingress: Extract<SessionStateIngress, { type: "event.received" }>,
  env: SessionStateReducerEnvironment,
): SessionStateReducerResult {
  const context = getSessionContext(state.session);
  const currentGameplay = getGameplayViewport(state.session);
  const nextSyncId = state.activity.syncId + 1;
  const debugEvent = ingress.source === "live" ? ingress.debugEvent : undefined;

  switch (ingress.event.type) {
    case "session.gameplayUpdated": {
      if (!context || !ingress.event.context) return { state, effects: [] };
      if (
        ingress.source === "live" &&
        ((state.session.type === "gameplay" &&
          ingress.event.perspective.playerId !==
            state.session.perspective.playerId) ||
          (state.session.type === "gameplayLoading" &&
            ingress.event.perspective.playerId !==
              state.session.requestedPlayerId))
      ) {
        return { state, effects: [] };
      }
      if (
        shouldIgnoreGameplayUpdate(currentGameplay, ingress.event.gameplay) &&
        context.lifecycle.status === ingress.event.lifecycle.status
      ) {
        return { state, effects: [] };
      }
      const nextContext = {
        ...ingress.event.context,
        history: toHistoryState(ingress.event.history),
        lifecycle: ingress.event.lifecycle,
      };
      const updatedState = applyGameplaySnapshotToState(
        state,
        ingress.event.gameplay,
        nextContext,
        {
          nextSyncId,
          perspective: ingress.event.perspective,
          debugEvent,
          env,
        },
      );
      const effects: SessionStateEffect[] = [
        {
          type: "perf.storeApplied",
          gameplayVersion: ingress.event.gameplay.version,
          syncId: nextSyncId,
        },
      ];
      if (hasBoardStaticHashMismatch(currentGameplay, ingress.event.gameplay)) {
        effects.push({
          type: "requestGameplayResync",
          sessionId: context.identity.sessionId,
          playerId: ingress.event.perspective.playerId,
          reason: `boardStaticHash mismatch cached=${currentGameplay?.boardStaticHash} incoming=${ingress.event.gameplay.boardStaticHash}`,
        });
      }
      return { state: updatedState, effects };
    }
    case "session.historyUpdated": {
      const nextContext = ingress.event.context;
      if (!nextContext) return { state, effects: [] };
      return {
        state: {
          ...state,
          session: withContext(state.session, nextContext),
          activity: {
            ...state.activity,
            syncId: nextSyncId,
            lastSyncTimestamp: env.nowMs(),
          },
          debug: {
            ...state.debug,
            sessionEvents: debugEvent
              ? appendSessionEvent(state, debugEvent, env)
              : state.debug.sessionEvents,
          },
          connection: {
            ...state.connection,
            error: null,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    }
    case "session.ended": {
      const nextContext = ingress.event.context;
      if (
        !nextContext ||
        !currentGameplay ||
        state.session.type !== "gameplay"
      ) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          session: {
            type: "ended",
            context: nextContext,
            perspective: state.session.perspective,
            gameplay: currentGameplay,
          },
          activity: {
            ...state.activity,
            syncId: nextSyncId,
            lastSyncTimestamp: env.nowMs(),
          },
          debug: {
            ...state.debug,
            sessionEvents: debugEvent
              ? appendSessionEvent(state, debugEvent, env)
              : state.debug.sessionEvents,
          },
          connection: {
            ...state.connection,
            error: null,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    }
    case "session.error":
      return {
        state: {
          ...state,
          session: {
            type: "error",
            message: ingress.event.message,
            context: context ?? undefined,
          },
          activity: {
            ...state.activity,
            syncId: nextSyncId,
            lastSyncTimestamp: env.nowMs(),
          },
          debug: {
            ...state.debug,
            sessionEvents: debugEvent
              ? appendSessionEvent(state, debugEvent, env)
              : state.debug.sessionEvents,
          },
        },
        effects: [],
      };
    case "session.gameplayLog":
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            gameplayLogs: appendBounded(
              state.activity.gameplayLogs,
              ingress.event.entry,
              500,
            ),
            gameplayLogCursor: ingress.event.entry.cursor,
          },
          debug: {
            ...state.debug,
            sessionEvents: debugEvent
              ? appendSessionEvent(state, debugEvent, env)
              : state.debug.sessionEvents,
          },
        },
        effects: [],
      };
    case "session.gameplayLogsReset":
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            gameplayLogs: [],
            gameplayLogCursor: ingress.event.cursor,
            gameplayLogResetReason: ingress.event.reason,
          },
          debug: {
            ...state.debug,
            sessionEvents: debugEvent
              ? appendSessionEvent(state, debugEvent, env)
              : state.debug.sessionEvents,
          },
        },
        effects: [],
      };
  }
}

export function reduceSessionState(
  state: UnifiedSessionState,
  ingress: SessionStateIngress,
  env: SessionStateReducerEnvironment,
): SessionStateReducerResult {
  switch (ingress.type) {
    case "command.loading":
      return {
        state: {
          ...state,
          session: { type: "loading", target: ingress.target },
          connection: {
            ...state.connection,
            error: null,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    case "command.failed":
      return {
        state: {
          ...state,
          session: {
            type: "error",
            message: ingress.message,
            context: getSessionContext(state.session) ?? undefined,
          },
        },
        effects: [],
      };
    case "snapshot.loaded":
      return {
        state: reduceSnapshotLoaded(state, ingress, env),
        effects: [],
      };
    case "event.received":
      return reduceEventReceived(state, ingress, env);
    case "connection.prepared": {
      const context = getSessionContext(state.session);
      if (!context) return { state, effects: [] };
      return {
        state: {
          ...state,
          session: withContext(state.session, {
            ...context,
            userId: ingress.userId,
            switchablePlayerIds: ingress.switchablePlayerIds,
          }),
          connection: {
            ...state.connection,
            error: null,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    }
    case "connection.changed": {
      const connection = {
        ...state.connection,
        [ingress.channel]: ingress.connected,
      };
      return {
        state: {
          ...state,
          connection: {
            ...connection,
            isConnected: connection.lobby || connection.gameplay,
            recovery: ingress.connected
              ? {
                  active: false,
                  message: null,
                  retryAfterMs: null,
                  attempt: null,
                  since: null,
                }
              : connection.recovery,
          },
        },
        effects: [],
      };
    }
    case "connection.failed":
      return {
        state: {
          ...state,
          connection: {
            ...state.connection,
            error: ingress.message,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    case "connection.recovering":
      return {
        state: {
          ...state,
          connection: {
            ...state.connection,
            error: null,
            recovery: {
              active: true,
              message: ingress.message,
              retryAfterMs: ingress.retryAfterMs,
              attempt: ingress.attempt,
              since: state.connection.recovery.since ?? env.nowMs(),
            },
          },
        },
        effects: [],
      };
    case "connection.errorCleared":
      return {
        state: {
          ...state,
          connection: { ...state.connection, error: null },
        },
        effects: [],
      };
    case "feedback.actionRejected": {
      const { notification, hostFeedback } = createActionRejectedArtifacts(
        ingress.reason,
        ingress.targetPlayer,
        env,
      );
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            notifications: [...state.activity.notifications, notification],
            hostFeedback: [...state.activity.hostFeedback, hostFeedback],
          },
        },
        effects: [],
      };
    }
    case "local.playerSelected": {
      const context = getSessionContext(state.session);
      if (!context) return { state, effects: [] };
      const controllablePlayerIds = resolveControllablePlayerIds(
        context.switchablePlayerIds,
        context.seats,
        context.userId,
        env.fallbackToAllSeatsWhenUserIdMissing,
      );
      if (!controllablePlayerIds.includes(ingress.playerId)) {
        return {
          state,
          effects: [
            {
              type: "log.warn",
              message: `[UnifiedSession] Cannot switch to ${ingress.playerId} - not controllable`,
            },
          ],
        };
      }
      const currentGameplay = getGameplayViewport(state.session);
      const localGameplay = currentGameplay
        ? gameplayViewportForPlayer(currentGameplay, ingress.playerId)
        : null;
      if (localGameplay) {
        return {
          state: applyGameplaySnapshotToState(state, localGameplay, context, {
            nextSyncId: state.activity.syncId + 1,
            perspective: { playerId: ingress.playerId },
            env,
          }),
          effects: [
            {
              type: "reconnectGameplay",
              sessionId: ingress.sessionId,
              playerId: ingress.playerId,
              source: "player-switch",
            },
          ],
        };
      }
      return {
        state: {
          ...state,
          session: {
            type: "gameplayLoading",
            context,
            requestedPlayerId: ingress.playerId,
          },
        },
        effects: [
          {
            type: "reconnectGameplay",
            sessionId: ingress.sessionId,
            playerId: ingress.playerId,
            source: "player-switch",
          },
        ],
      };
    }
    case "activity.stateAcked":
      return {
        state: {
          ...state,
          activity: { ...state.activity, lastAckTimestamp: env.nowMs() },
        },
        effects: [],
      };
    case "activity.notificationRead":
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            notifications: state.activity.notifications.map((notification) =>
              notification.id === ingress.id
                ? { ...notification, read: true }
                : notification,
            ),
          },
        },
        effects: [],
      };
    case "activity.notificationsCleared":
      return {
        state: {
          ...state,
          activity: { ...state.activity, notifications: [] },
        },
        effects: [],
      };
    case "activity.hostFeedbackDismissed":
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            hostFeedback: state.activity.hostFeedback.filter(
              (item) => item.id !== ingress.id,
            ),
          },
        },
        effects: [],
      };
    case "activity.hostFeedbackCleared":
      return {
        state: {
          ...state,
          activity: { ...state.activity, hostFeedback: [] },
        },
        effects: [],
      };
    case "activity.gameplayLogsCleared":
      return {
        state: {
          ...state,
          activity: {
            ...state.activity,
            gameplayLogs: [],
            gameplayLogResetReason: null,
          },
        },
        effects: [],
      };
    case "debug.sessionEventsCleared":
      return {
        state: { ...state, debug: { ...state.debug, sessionEvents: [] } },
        effects: [],
      };
    case "streams.closed":
      return {
        state: {
          ...state,
          connection: {
            ...state.connection,
            lobby: false,
            gameplay: false,
            isConnected: false,
            recovery: {
              active: false,
              message: null,
              retryAfterMs: null,
              attempt: null,
              since: null,
            },
          },
        },
        effects: [],
      };
    case "session.reset":
      return { state: createInitialUnifiedSessionState(), effects: [] };
  }
}
