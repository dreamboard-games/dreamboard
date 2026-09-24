# Build a first game

Begin with a deliberately small rule: two seats share a counter, and player1 can
increment it. Use this to prove the complete authoring/iframe path before adding
turn changes, scoring or an ending. Describe the real game in `rule.md`, then
expand rules and tests together.

`manifest.ts`:

```ts
import { defineTopologyManifest } from "@dreamboard-games/sdk/reducer";
export default defineTopologyManifest({
  players: { minPlayers: 2, maxPlayers: 2 },
  cardSets: [],
  zones: [],
  boards: [],
});
```

`app/game.ts`:

```ts
import { z } from "zod";
import { createGame } from "@dreamboard-games/sdk/reducer";
import manifest from "../manifest";

const model = createGame({
  manifest,
  state: {
    public: z.object({ count: z.number().int() }),
    private: z.object({}),
    hidden: z.object({}),
  },
  phases: { play: z.object({}) },
});
const play = model.phase("play");
export default model.assemble({
  initial: { public: () => ({ count: 0 }) },
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
      },
    }),
  },
  view: ({ state }) => ({ count: state.publicState.count }),
});
```

`app/index.ts`:

```ts
import { createReducerBundle } from "@dreamboard-games/sdk/reducer";
import game from "./game";
export default createReducerBundle(game);
```

Add the UI from [interface](game-interface.md). Run TypeScript and Vitest, then the
actual local host. Assert initial count0, accepted increment to1 and wrong-seat
rejection without state change. Switch seats in the browser: the second seat must
not gain an enabled action merely because the UI displays the same public count.

When extending the game, add JSON-native initialization options to the bound
model, ordinary phases/transactions, and explicit terminal outcomes. Use seeded
transaction RNG for randomness. Keep state in the session rather than module
globals. Include a complete ending scenario once the rules define one.
