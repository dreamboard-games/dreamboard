import {
  type InteractionDescriptor,
  type PluginGameplayFrame,
  type RuntimeJson,
  type SimultaneousPhaseSnapshot,
  type ZoneHandlesSnapshot,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import {
  principalKey,
  principalMatchesActor,
  seatsForPluginSnapshot,
} from "./actor-principal.js";
import type {
  GameplayViewport,
  HistoryState,
  SessionContext,
  SessionIdentity,
  UnifiedSessionModel,
} from "./session-model.js";
import type { Notification } from "./session-state-reducer.js";
import {
  getGameplayViewport,
  getSessionContext,
  resolveControllablePlayerIds,
} from "./session-model.js";

export interface NotificationProjectionState {
  notifications: Notification[];
  syncId: number;
}

export interface ProjectionState {
  session: UnifiedSessionModel;
  activity: NotificationProjectionState;
}

export interface LobbyViewModel {
  identity: SessionIdentity;
  seats: SessionContext["seats"];
  canStart: boolean;
  hostActor: SessionContext["hostActor"];
  shortCode: string;
  isSessionHost: boolean;
}

export interface GameplayViewModel {
  context: SessionContext;
  perspective: { playerId: string };
  gameplay: GameplayViewport;
}

export type BootstrapStatus = "loading" | "lobby" | "renderable" | "error";

const lobbyViewModelCache = new WeakMap<SessionContext, LobbyViewModel>();
const gameplayViewModelCache = new WeakMap<
  GameplayViewport,
  { context: SessionContext; value: GameplayViewModel }
>();

export interface HostPluginDebugProjection {
  view: RuntimeJson | null;
  gameplay: {
    currentPhase: string | null;
    currentStage: string | null;
    activePlayers: string[];
    simultaneousPhase: SimultaneousPhaseSnapshot | null;
    availableInteractions: InteractionDescriptor[];
    zones: Record<string, ZoneHandlesSnapshot>;
  };
  lobby: {
    seats: ReturnType<typeof seatsForPluginSnapshot>;
    canStart: boolean;
    hostUserId: string;
  };
  notifications: Notification[];
  session: {
    sessionId: string | null;
    controllablePlayerIds: string[];
    controllingPlayerId: string | null;
    userId: string | null;
  };
  history: HistoryState | null;
  syncId: number;
}

export function selectSessionContext(
  state: Pick<ProjectionState, "session">,
): SessionContext | null {
  return getSessionContext(state.session);
}

export function selectGameplayViewport(
  state: Pick<ProjectionState, "session">,
): GameplayViewport | null {
  return getGameplayViewport(state.session);
}

export function selectSessionType(
  state: Pick<ProjectionState, "session">,
): UnifiedSessionModel["type"] {
  return state.session.type;
}

export function selectBootstrapStatus(
  state: Pick<ProjectionState, "session">,
): BootstrapStatus {
  switch (state.session.type) {
    case "idle":
    case "loading":
    case "gameplayLoading":
      return "loading";
    case "lobby":
    case "ended":
      return "lobby";
    case "gameplay":
      return "renderable";
    case "error":
      return "error";
  }
}

export function selectSessionError(
  state: Pick<ProjectionState, "session">,
): string | null {
  return state.session.type === "error" ? state.session.message : null;
}

export function selectLobbyViewModel(
  state: Pick<ProjectionState, "session">,
): LobbyViewModel | null {
  const context = getSessionContext(state.session);
  if (!context) return null;
  const cached = lobbyViewModelCache.get(context);
  if (cached) return cached;
  const viewModel = {
    identity: context.identity,
    seats: context.seats,
    canStart: context.canStart,
    hostActor: context.hostActor,
    shortCode: context.identity.shortCode,
    isSessionHost:
      Boolean(context.userId) &&
      principalMatchesActor(context.userId, context.hostActor),
  };
  lobbyViewModelCache.set(context, viewModel);
  return viewModel;
}

export function selectGameplayViewModel(
  state: Pick<ProjectionState, "session">,
): GameplayViewModel | null {
  if (state.session.type !== "gameplay") return null;
  const cached = gameplayViewModelCache.get(state.session.gameplay);
  if (cached?.context === state.session.context) return cached.value;
  const value = {
    context: state.session.context,
    perspective: state.session.perspective,
    gameplay: state.session.gameplay,
  };
  gameplayViewModelCache.set(state.session.gameplay, {
    context: state.session.context,
    value,
  });
  return value;
}

export function selectPluginDebugProjection(
  state: ProjectionState,
  fallbackToAllSeatsWhenUserIdMissing = false,
): HostPluginDebugProjection {
  const context = getSessionContext(state.session);
  const gameplay = getGameplayViewport(state.session);
  const perspectivePlayerId =
    state.session.type === "gameplay"
      ? state.session.perspective.playerId
      : null;
  const controllablePlayerIds = context
    ? resolveControllablePlayerIds(
        context.switchablePlayerIds,
        context.seats,
        context.userId,
        fallbackToAllSeatsWhenUserIdMissing,
      )
    : [];
  const controllingPlayerId = perspectivePlayerId;
  const gameplayIsRenderable =
    gameplay !== null && perspectivePlayerId !== null;
  const visibleInteractions: InteractionDescriptor[] = gameplayIsRenderable
    ? gameplay.availableInteractions
    : [];
  const seatView = gameplayIsRenderable ? gameplay.view : null;
  const boardStatic = gameplay?.boardStatic ?? null;
  const view: RuntimeJson | null =
    boardStatic && seatView && typeof seatView === "object"
      ? ({
          ...(seatView as Record<string, unknown>),
          board: {
            ...((seatView as { board?: Record<string, unknown> }).board ?? {}),
            ...boardStatic,
          },
        } as RuntimeJson)
      : boardStatic && !seatView
        ? ({ board: boardStatic } as RuntimeJson)
        : seatView;
  const visibleZones: Record<string, ZoneHandlesSnapshot> = gameplayIsRenderable
    ? gameplay.zones
    : {};

  return {
    view,
    gameplay: {
      currentPhase: gameplay?.currentPhase ?? null,
      currentStage: gameplay?.currentStage ?? null,
      activePlayers: gameplay?.activePlayers ?? [],
      simultaneousPhase: gameplay?.simultaneousPhase ?? null,
      availableInteractions: visibleInteractions,
      zones: visibleZones,
    },
    lobby: {
      seats: seatsForPluginSnapshot(context?.seats ?? []),
      canStart: context?.canStart ?? false,
      hostUserId: context ? principalKey(context.hostActor) : "",
    },
    notifications: state.activity.notifications,
    session: {
      sessionId: context?.identity.sessionId ?? null,
      controllablePlayerIds,
      controllingPlayerId,
      userId: context?.userId ?? null,
    },
    history: context?.history ?? null,
    syncId: state.activity.syncId,
  };
}

export function selectPluginGameplayFrame(
  state: Pick<ProjectionState, "session">,
): PluginGameplayFrame | null {
  if (state.session.type !== "gameplay") return null;

  return state.session.gameplay.canonicalFrame;
}

export function selectHistory(
  state: Pick<ProjectionState, "session">,
): HistoryState | null {
  return getSessionContext(state.session)?.history ?? null;
}
