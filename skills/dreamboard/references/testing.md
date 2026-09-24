# Testing

Use project TypeScript and Vitest checks, then the real offline browser host.
Import browser-safe local/scenario helpers from `/testing`:

```ts
import { localSource } from "@dreamboard-games/sdk/testing";
import definition from "../app/game";
const source = await localSource(definition, { players: 2, seed: 1 });
const checkpoint = JSON.parse(JSON.stringify(source.checkpoint()));
source.restore(checkpoint);
console.log(source.inspect());
source.dispose();
```

Use actual player counts and named scenarios from the game. localSource and
scenarioSource expose selected-seat frames, explicit typed apply commands,
bounded explore, checkpoint/restore and switchSeat(playerId). Full checkpoints
contain hidden state and stay in test/developer tooling. restore validates unknown
JSON before mutation and publishes a new source revision. createTestSource is the
controlled request-order fixture, not a second gameplay implementation.

## Meaningful proofs

- Opening projections, legal actions and complete game endings.
- Wrong actors, invalid domains/rules and terminal rejection with unchanged state.
- Seeded RNG determinism and rejection rollback.
- Each seat's hidden-card and private-step isolation.
- Independent input order and atomic multi-selection.
- Committed steps: new intent per step, valid-prefix retention, suffix truncation,
  phase-entry clearing, blocked-step cancel, and restore of saved choices.
- ACK-before-frame/frame-before-ACK, rejection preserving valid drafts, and newer
  controlled edits surviving a previous accepted request.

Use pure tests for scoring/topology algorithms; real scenarios for integration.
Create named checkpoints through normal game commands instead of test-only
production setup paths. A coverage test should render the actual panels before
assertCoverage; pre-reading every interaction hides missing renderers.

## Browser workflow

Run `pnpm dev`, interact with actual controls, switch seats, reject an invalid
move, cancel/reset selections, save/restore, and play to an ending. Exercise narrow
and wide layouts, keyboard and touch. Use public DOM data attributes or copied
browser helpers, not command tapes or an injected second action protocol.

The dev-host repository separately proves worker termination, opaque-frame
isolation, persistence-before-publication and resume. Component tests alone do
not establish those boundaries. Once loaded, gameplay stays local without remote
services; reloading still requires the running loopback server.
