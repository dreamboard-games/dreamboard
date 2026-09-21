import { describe, expect, test } from "bun:test";
import type { GameplayViewport, SessionContext } from "./session-model.js";
import {
  createInitialUnifiedSessionState,
  reduceSessionState,
  type SessionStateReducerEnvironment,
} from "./session-state-reducer.js";

const env: SessionStateReducerEnvironment = {
  fallbackToAllSeatsWhenUserIdMissing: false,
  nextEventId: () => 1,
  nextNotificationId: () => "notification-1",
  nowMs: () => 1,
  nowIso: () => "2026-07-15T00:00:00.000Z",
};

const gameplay: GameplayViewport = {
  version: 2,
  actionSetVersion: "actions-2",
  activePlayers: ["player-1"],
  currentPhase: "main",
  currentStage: null,
  stageSeats: [],
  simultaneousPhase: null,
  view: null,
  availableInteractions: [],
  zones: {},
  boardStatic: null,
  boardStaticHash: null,
  seatProjectionsByPlayerId: {},
  canonicalFrame: null,
};

function activeContext(): SessionContext {
  return {
    gameplayWebsocketUrl: "ws://127.0.0.1:3006/v1/connect",
    identity: {
      sessionId: "00000000-0000-4000-8000-000000000401",
      shortCode: "ABC123",
      projectId: "project-1",
    },
    userId: "user-1",
    seats: [],
    canStart: false,
    phase: "started",
    gameSource: { type: "project", projectId: "project-1" },
    hostActor: { type: "user", userId: "user-1" },
    switchablePlayerIds: ["player-1"],
    history: null,
    lifecycle: { status: "active" },
  };
}

describe("session state reducer", () => {
  test("applies a lifecycle transition carried by an unchanged gameplay revision", () => {
    const context = activeContext();
    const initial = createInitialUnifiedSessionState();
    const state = {
      ...initial,
      session: {
        type: "gameplay" as const,
        context,
        perspective: { playerId: "player-1" },
        gameplay,
      },
    };

    const result = reduceSessionState(
      state,
      {
        type: "event.received",
        source: "live",
        event: {
          type: "session.gameplayUpdated",
          context,
          gameplay,
          perspective: { playerId: "player-1" },
          history: { entries: [] },
          lifecycle: {
            status: "ended",
            endedAt: "2026-07-15T00:00:00.000Z",
            outcome: {
              reason: { code: "complete" },
              standings: [{ playerId: "player-1", rank: 1, result: "win" }],
            },
          },
        },
      },
      env,
    );

    expect(result.state.session.type).toBe("ended");
    expect(result.effects).toEqual([
      { type: "perf.storeApplied", gameplayVersion: 2, syncId: 1 },
    ]);
  });
});
