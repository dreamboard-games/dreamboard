import type { SessionControlSnapshot } from "@dreamboard-games/api-client";
import type { PluginGameplayFrame } from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { ServerGameplayFrame } from "@dreamboard-games/gameplay-authority-client";
import type {
  GameplayPerspective,
  GameplayViewport,
  SessionContext,
} from "./session-model.js";
import {
  contextFromHostSnapshot,
  gameplayViewportFromPluginFrame,
} from "./session-model.js";

export interface HostSessionStream {
  stream: AsyncIterable<HostSessionWireEvent | null | undefined>;
}

export interface GameplayLogEntry {
  cursor: number;
  version: number;
  clientActionId?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

export type GameplayLogResetReason = "retention-gap" | "owner-replaced";

export type HostSessionWireEvent =
  | {
      type: "session.gameplayUpdated";
      gameplay: PluginGameplayFrame;
      history: Extract<
        ServerGameplayFrame,
        { type: "session.snapshot" }
      >["history"];
      lifecycle: Extract<
        ServerGameplayFrame,
        { type: "session.snapshot" }
      >["lifecycle"];
    }
  | { type: "session.historyUpdated" }
  | { type: "session.ended" }
  | {
      type: "session.error";
      sessionId: string;
      code?: string | null;
      message: string;
      recoverable: boolean;
    }
  | { type: "session.gameplayLog"; entry: GameplayLogEntry }
  | {
      type: "session.gameplayLogsReset";
      cursor: number;
      reason: GameplayLogResetReason;
    };

export type NormalizedSessionSnapshot =
  | {
      type: "lobby";
      context: SessionContext;
      gameplay: null;
      preferredPlayerId: string | null;
    }
  | {
      type: "started";
      context: SessionContext;
      gameplay: null;
      preferredPlayerId: string | null;
    };

export type NormalizedSessionEvent =
  | {
      type: "session.gameplayUpdated";
      context: SessionContext | null;
      gameplay: GameplayViewport;
      perspective: GameplayPerspective;
      history: Extract<
        ServerGameplayFrame,
        { type: "session.snapshot" }
      >["history"];
      lifecycle: Extract<
        ServerGameplayFrame,
        { type: "session.snapshot" }
      >["lifecycle"];
    }
  | {
      type: "session.historyUpdated";
      context: SessionContext | null;
      gameplay: GameplayViewport | null;
    }
  | {
      type: "session.ended";
      context: SessionContext | null;
      gameplay: GameplayViewport | null;
    }
  | {
      type: "session.error";
      message: string;
      code?: string;
      context: SessionContext | null;
      gameplay: GameplayViewport | null;
    }
  | { type: "session.gameplayLog"; entry: GameplayLogEntry }
  | {
      type: "session.gameplayLogsReset";
      cursor: number;
      reason: GameplayLogResetReason;
    };

export function normalizeSnapshot(
  snapshot: SessionControlSnapshot,
  options: { userId: string | null },
): NormalizedSessionSnapshot {
  const context = contextFromHostSnapshot(snapshot, options.userId);
  const preferredPlayerId = context.switchablePlayerIds[0] ?? null;
  return snapshot.context.phase === "lobby"
    ? { type: "lobby", context, gameplay: null, preferredPlayerId }
    : { type: "started", context, gameplay: null, preferredPlayerId };
}

export function normalizeEvent(
  event: HostSessionWireEvent,
  options: {
    currentContext: SessionContext | null;
    currentGameplay: GameplayViewport | null;
    userId: string | null;
  },
): NormalizedSessionEvent {
  const context = options.currentContext
    ? { ...options.currentContext, userId: options.userId }
    : null;
  switch (event.type) {
    case "session.gameplayUpdated": {
      const gameplay = gameplayViewportFromPluginFrame(
        event.gameplay,
        options.currentGameplay,
      );
      return {
        type: event.type,
        context,
        gameplay,
        perspective: {
          playerId: event.gameplay.basis.perspectivePlayerId,
        },
        history: event.history,
        lifecycle: event.lifecycle,
      };
    }
    case "session.historyUpdated":
    case "session.ended":
      return {
        type: event.type,
        context,
        gameplay: options.currentGameplay,
      };
    case "session.error":
      return {
        type: event.type,
        message: event.message,
        code: event.code ?? undefined,
        context,
        gameplay: options.currentGameplay,
      };
    case "session.gameplayLog":
    case "session.gameplayLogsReset":
      return event;
  }
}
