import { z } from "zod";
import { createGame } from "@dreamboard-games/sdk/reducer";
import manifest from "../manifest";
const game = createGame({
  manifest,
  options: z.strictObject({ start: z.number().int().default(0) }),
  state: {
    public: z.object({ count: z.number(), roll: z.number().nullable() }),
    private: z.object({ secret: z.string() }),
    hidden: z.object({ secret: z.string() }),
  },
  phases: { play: z.object({}) },
  errors: { NOPE: "Choose the accepted option." },
});
const play = game.phase("play");
export default game.assemble({
  initial: {
    public: ({ options }) => ({ count: options.start, roll: null }),
    private: ({ playerId }) => ({ secret: `secret-${playerId}` }),
    hidden: () => ({ secret: "host-only" }),
  },
  initialPhase: "play",
  phases: {
    play: play.define({
      kind: "player",
      initialState: () => ({}),
      enter({ tx, state }) {
        tx.setActivePlayers([state.table.playerOrder[0]]);
      },
      interactions: {
        increment: play.interaction({
          inputs: {},
          reduce({ tx, state }) {
            tx.patchPublicState({ count: state.publicState.count + 1 });
          },
        }),
        choose: play.interaction({
          steps: play
            .steps()
            .input(
              "choice",
              play.inputs.form.choice({
                choices: [
                  { value: "accept", label: "Accept" },
                  { value: "reject", label: "Reject" },
                ],
                defaultValue: () => undefined,
              }),
            )
            .input("confirm", () => ({
              ...play.inputs.form.choice({
                choices: [{ value: null, label: "Confirm" }],
                defaultValue: () => undefined,
              }),
              schema: z.null(),
            })),
          reduce({ tx, input, random, state }) {
            const roll = random.integer({ minInclusive: 1, maxInclusive: 6 });
            tx.patchPublicState({ count: state.publicState.count + 1, roll });
            tx.emit({
              kind: "systemAction",
              procedureId: "choose",
              title: "Choice accepted",
            });
            if (input.params.choice === "reject")
              return tx.reject("NOPE", "Choose the accepted option.");
          },
        }),
      },
    }),
  },
  view: game.view(({ state, playerId }) => ({
    ...state.publicState,
    secret: state.privateState[playerId].secret,
  })),
});
