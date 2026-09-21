import { describe, expect, test } from "bun:test";
import { projectionToGameplayFrame } from "./projection-to-gameplay-frame.js";
import type { ScreenshotProjection } from "./projection-to-gameplay-frame.js";
import { createStaticStoreApi } from "./static-store-api.js";

describe("projectionToGameplayFrame", () => {
  test("wraps a generated projection in a plugin gameplay frame", () => {
    const projection = {
      currentStage: "playerTurn",
      stageSeats: ["player-1"],
      view: { resources: { wood: 2 } },
      availableInteractions: [
        {
          kind: "action",
          phaseName: "playerTurn",
          interactionKey: "playerTurn.trade",
          interactionId: "trade",
          label: "Trade",
          descriptorDigest: "sha256:trade",
          commit: { mode: "manual" },
          inputs: [],
          availability: { status: "available" },
        },
      ],
      zones: {
        hand: {
          cardIds: ["card-1"],
          cardViewsById: { "card-1": '{"name":"Wood"}' },
          playableByCardId: {
            "card-1": [
              {
                kind: "action",
                phaseName: "playerTurn",
                interactionKey: "playerTurn.playCard",
                interactionId: "playCard",
                label: "Play card",
                descriptorDigest: "sha256:play-card",
                commit: { mode: "manual" },
                inputs: [],
                availability: { status: "available" },
              },
            ],
          },
        },
      },
    } satisfies ScreenshotProjection;

    const frame = projectionToGameplayFrame(projection, {
      controllingPlayerId: "player-1",
      playerIds: ["player-1", "player-2", "player-3", "player-4"],
    });

    expect(frame.view).toEqual(projection.view);
    expect(frame.flow.currentPhase).toBe("playerTurn");
    expect(frame.flow.currentStage).toBe("playerTurn");
    expect(frame.flow.activePlayers).toEqual(["player-1"]);
    expect(frame.availableInteractions).toEqual(
      projection.availableInteractions,
    );
    expect(frame.zones).toEqual(projection.zones);
    expect(frame.basis.perspectivePlayerId).toBe("player-1");
    expect(frame.basis.version).toBe(1);
    expect(frame.basis.actionSetVersion).toBe("screenshot-frame:1");
  });

  test("static store returns a frozen gameplay frame", () => {
    const frame = projectionToGameplayFrame({
      currentStage: "playerTurn",
      stageSeats: ["player-2"],
      view: { ok: true },
    });
    const store = createStaticStoreApi(frame);
    const nextFrame = store.getGameplayFrame();

    expect(nextFrame?.basis).toEqual(frame.basis);
    expect(nextFrame?.flow.currentStage).toBe("playerTurn");
    expect(nextFrame?.view).toEqual({ ok: true });
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.flow)).toBe(true);
    expect(store.subscribe(() => undefined)()).toBeUndefined();
  });

  test("prefers an explicit projection phase when present", () => {
    const frame = projectionToGameplayFrame({
      currentPhase: "playing",
      currentStage: "playerTurn",
      view: { currentPhase: "passing" },
    });

    expect(frame.flow.currentPhase).toBe("playing");
    expect(frame.flow.currentStage).toBe("playerTurn");
  });
});
