import { describe, expect, test } from "vitest";
import { ClientGameplayFrameSchema } from "@dreamboard-games/gameplay-authority-protocol";
import { encodeClientGameplayFrame } from "./client-frame-codec.js";

describe("encodeClientGameplayFrame", () => {
  test("encodes a valid interaction.submit frame that round-trips through the schema", () => {
    const encoded = encodeClientGameplayFrame({
      type: "interaction.submit",
      clientActionId: "client-action-1",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: { cardId: "card-1" },
    });

    expect(ClientGameplayFrameSchema.parse(JSON.parse(encoded))).toEqual({
      type: "interaction.submit",
      clientActionId: "client-action-1",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: { cardId: "card-1" },
    });
  });

  test("rejects a frame that violates the contract", () => {
    expect(() =>
      encodeClientGameplayFrame({
        type: "interaction.submit",
        clientActionId: "client-action-1",
        basis: {
          version: -1,
          actionSetVersion: "3:main",
          perspectivePlayerId: "player-1",
        },
        interactionId: "play-card",
        params: {},
      }),
    ).toThrow();
  });

  test("rejects an unknown frame type", () => {
    expect(() =>
      encodeClientGameplayFrame({
        type: "auth.connect",
        // The credential must be non-empty
        credential: { kind: "user", token: "" },
        sessionId: "00000000-0000-4000-8000-000000000001",
        playerId: "player-1",
      }),
    ).toThrow();
  });
});
