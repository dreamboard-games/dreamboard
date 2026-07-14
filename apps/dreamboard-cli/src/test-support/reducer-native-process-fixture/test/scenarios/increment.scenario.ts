import { defineScenario } from "../testing-types.js";

export default defineScenario({
  id: "fixture.increment",
  setup: { players: 1, seed: 17 },
  given: [],
  when: [
    {
      actor: { seat: 0 },
      interactionId: "increment",
      params: { amount: 1 },
    },
  ],
  then: ({ expect, view }) => {
    expect(view({ seat: 0 })).toEqual({
      count: 1,
      playerId: "player-1",
    });
  },
});
