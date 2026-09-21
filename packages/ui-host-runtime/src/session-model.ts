import type {
  SeatAssignment,
  SessionActor,
  SessionGameSource,
} from "@dreamboard-games/api-client";
import type {
  GameOutcome,
  InteractionDescriptor,
  PluginGameplayFrame,
  RuntimeJson,
  ZoneHandlesSnapshot,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import {
  seatControlledByPrincipal,
  projectIdFromGameSource,
} from "./actor-principal.js";

type LayoutConfig = unknown;
type CardDisplayConfig = unknown;

export interface SessionIdentity {
  sessionId: string;
  shortCode: string;
  projectId: string;
}

export interface HistoryState {
  entries: Array<{
    version: number;
    timestamp: string;
    description: string;
    isCurrent: boolean;
  }>;
  currentIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface SessionContextIngress {
  sessionId: string;
  shortCode: string;
  gameplayWebsocketUrl: string;
  phase: "lobby" | "started";
  gameSource: SessionGameSource;
  setupProfileId?: string | null;
  hostActor: SessionActor;
  switchablePlayerIds: string[];
  history?: { entries: HistoryState["entries"] } | null;
}

export type GameplayLifecycle =
  | { status: "active" }
  | {
      status: "ended";
      outcome: GameOutcome;
      endedAt: string;
    };

export interface LobbyIngress {
  seats: SeatAssignment[];
  canStart: boolean;
}

export interface SessionContext {
  gameplayWebsocketUrl: string;
  identity: SessionIdentity;
  userId: string | null;
  seats: SeatAssignment[];
  canStart: boolean;
  phase: "lobby" | "started";
  gameSource: SessionGameSource;
  setupProfileId?: string | null;
  hostActor: SessionActor;
  switchablePlayerIds: string[];
  history: HistoryState | null;
  lifecycle: GameplayLifecycle;
}

export interface GameplayPerspective {
  playerId: string;
}

export interface GameplayViewport {
  version: number;
  actionSetVersion: string;
  activePlayers: string[];
  currentPhase: string | null;
  currentStage: string | null;
  stageSeats: string[];
  simultaneousPhase: SimultaneousPhaseSnapshot | null;
  view: RuntimeJson | null;
  availableInteractions: InteractionDescriptor[];
  zones: Record<string, ZoneHandlesSnapshot>;
  boardStatic: Record<string, unknown> | null;
  boardStaticHash: string | null;
  layout?: LayoutConfig | null;
  cardDisplayConfigs?: CardDisplayConfig[] | null;
  seatProjectionsByPlayerId: Record<string, GameplaySeatProjection>;
  canonicalFrame: PluginGameplayFrame | null;
}

export interface GameplaySeatProjection {
  version: number;
  actionSetVersion: string;
  view: RuntimeJson | null;
  availableInteractions: InteractionDescriptor[];
  zones: Record<string, ZoneHandlesSnapshot>;
}

export interface SimultaneousPhaseSnapshot {
  phaseName: string;
  interactionId: string;
  actorIds: string[];
  sealedPlayerIds: string[];
  pendingPlayerIds: string[];
}

export type UnifiedSessionModel =
  | { type: "idle" }
  | { type: "loading"; target?: { sessionId?: string; shortCode?: string } }
  | { type: "lobby"; context: SessionContext; preferredPlayerId: string | null }
  | {
      type: "gameplayLoading";
      context: SessionContext;
      requestedPlayerId: string;
    }
  | {
      type: "gameplay";
      context: SessionContext;
      perspective: GameplayPerspective;
      gameplay: GameplayViewport;
    }
  | {
      type: "ended";
      context: SessionContext;
      perspective: GameplayPerspective;
      gameplay: GameplayViewport;
    }
  | { type: "error"; message: string; context?: SessionContext };

export type SessionPhase = UnifiedSessionModel["type"];

export function toHistoryState(
  history: SessionContextIngress["history"] | undefined,
): HistoryState | null {
  return history
    ? {
        entries: history.entries,
        currentIndex: history.entries.findIndex((entry) => entry.isCurrent),
        canGoBack: history.entries.findIndex((entry) => entry.isCurrent) > 0,
        canGoForward: false,
      }
    : null;
}

export function identityFromHostContext(
  context: SessionContextIngress,
): SessionIdentity {
  const projectId = projectIdFromGameSource(context.gameSource);
  return {
    sessionId: context.sessionId,
    shortCode: context.shortCode,
    projectId,
  };
}

export function deriveControlledPlayerIdsFromSeats(
  seats: SeatAssignment[],
  userId: string | null,
  fallbackToAllSeatsWhenUserIdMissing = false,
): string[] {
  if (!userId) {
    return fallbackToAllSeatsWhenUserIdMissing
      ? seats.map((seat) => seat.playerId)
      : [];
  }
  return seats
    .filter((seat) => seatControlledByPrincipal(seat, userId))
    .map((seat) => seat.playerId);
}

export function resolveControllablePlayerIds(
  preferredPlayerIds: string[] | null | undefined,
  seats: SeatAssignment[],
  userId: string | null,
  fallbackToAllSeatsWhenUserIdMissing = false,
): string[] {
  return preferredPlayerIds && preferredPlayerIds.length > 0
    ? preferredPlayerIds
    : deriveControlledPlayerIdsFromSeats(
        seats,
        userId,
        fallbackToAllSeatsWhenUserIdMissing,
      );
}

export function contextFromHostParts(
  wireContext: SessionContextIngress,
  lobby: LobbyIngress,
  userId: string | null,
): SessionContext {
  return {
    identity: identityFromHostContext(wireContext),
    gameplayWebsocketUrl: wireContext.gameplayWebsocketUrl,
    userId,
    seats: lobby.seats,
    canStart: lobby.canStart,
    phase: wireContext.phase,
    gameSource: wireContext.gameSource,
    setupProfileId: wireContext.setupProfileId ?? null,
    hostActor: wireContext.hostActor,
    switchablePlayerIds: wireContext.switchablePlayerIds,
    history: toHistoryState(wireContext.history),
    lifecycle: { status: "active" },
  };
}

export function contextFromHostSnapshot(
  snapshot: { context: SessionContextIngress; lobby: LobbyIngress },
  userId: string | null,
): SessionContext {
  return contextFromHostParts(snapshot.context, snapshot.lobby, userId);
}

export function contextWithHistory(
  context: SessionContext,
  history: SessionContextIngress["history"],
): SessionContext {
  return { ...context, history: toHistoryState(history) };
}

export function gameplayViewportFromPluginFrame(
  frame: PluginGameplayFrame,
  previous?: GameplayViewport | null,
): GameplayViewport {
  const playerId = frame.basis.perspectivePlayerId;
  const seatProjection: GameplaySeatProjection = {
    version: frame.basis.version,
    actionSetVersion: frame.basis.actionSetVersion,
    view: frame.view as RuntimeJson | null,
    availableInteractions: [...frame.availableInteractions],
    zones: { ...frame.zones },
  };
  return {
    version: frame.basis.version,
    actionSetVersion: frame.basis.actionSetVersion,
    activePlayers: [...frame.flow.activePlayers],
    currentPhase: frame.flow.currentPhase,
    currentStage: frame.flow.currentStage,
    stageSeats: [],
    simultaneousPhase: frame.flow.simultaneousPhase
      ? {
          ...frame.flow.simultaneousPhase,
          actorIds: [...frame.flow.simultaneousPhase.actorIds],
          sealedPlayerIds: [...frame.flow.simultaneousPhase.sealedPlayerIds],
          pendingPlayerIds: [...frame.flow.simultaneousPhase.pendingPlayerIds],
        }
      : null,
    view: frame.view as RuntimeJson | null,
    availableInteractions: [...frame.availableInteractions],
    zones: { ...frame.zones },
    boardStatic: previous?.boardStatic ?? null,
    boardStaticHash: previous?.boardStaticHash ?? null,
    layout: previous?.layout ?? null,
    cardDisplayConfigs: previous?.cardDisplayConfigs ?? null,
    seatProjectionsByPlayerId: {
      [playerId]: seatProjection,
    },
    canonicalFrame: frame,
  };
}

export function gameplayViewportForPlayer(
  gameplay: GameplayViewport,
  playerId: string,
): GameplayViewport | null {
  const seatProjection = gameplay.seatProjectionsByPlayerId[playerId];
  if (!seatProjection || seatProjection.version !== gameplay.version) {
    return null;
  }
  return {
    ...gameplay,
    actionSetVersion: seatProjection.actionSetVersion,
    view: seatProjection.view,
    availableInteractions: seatProjection.availableInteractions,
    zones: seatProjection.zones,
  };
}

export function getSessionContext(
  session: UnifiedSessionModel,
): SessionContext | null {
  switch (session.type) {
    case "lobby":
    case "gameplayLoading":
    case "gameplay":
    case "ended":
      return session.context;
    case "error":
      return session.context ?? null;
    case "idle":
    case "loading":
      return null;
  }
}

export function getGameplayViewport(
  session: UnifiedSessionModel,
): GameplayViewport | null {
  return session.type === "gameplay" || session.type === "ended"
    ? session.gameplay
    : null;
}

export function withContext(
  session: UnifiedSessionModel,
  context: SessionContext,
): UnifiedSessionModel {
  switch (session.type) {
    case "lobby":
      return { ...session, context };
    case "gameplayLoading":
      return { ...session, context };
    case "gameplay":
      return { ...session, context };
    case "ended":
      return { ...session, context };
    case "error":
      return { type: "error", message: session.message, context };
    case "idle":
    case "loading":
      return { type: "lobby", context, preferredPlayerId: null };
  }
}
