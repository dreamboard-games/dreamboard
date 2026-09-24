# Reducer authoring

Use `createGame(model)` from `/reducer`, `model.phase(name)` for bound helpers,
and `model.assemble` for initial state, phases and one view. Import the authored
manifest normally; optional `compileManifest(manifest)` gives canonical ID schemas,
initial tables and static boards without generated authoring files. The
[first-game example](building-your-first-game.md) contains a complete definition.

## State and transactions

Public, private, hidden, phase and table state have one authoritative owner.
Ordinary records represent per-player data. `model.types` contains phantom State,
Tx and Queries type carriers; do not read them at runtime.

Mutation callbacks receive tx. Use named methods such as patchPublicState,
patchPhaseState, setActivePlayers, transition, endGame, roll, shuffle and deal.
`state`/`q` describe the initial callback snapshot; tx.state/tx.q observe earlier
mutations in the same transaction. Bare return accepts; return tx.reject(code)
rejects without persisting state, RNG or emitted-event changes. Return lifecycle
results rather than constructing an alternate state engine.

Perform initialization mutations in phase entry. Declare options once as a
JSON-native Zod schema on createGame; the host supplies JSON and the reducer
validates/persists parsed options. Runtime transforms/coercion are not a wire
options contract. Use normal actor rules and explicit resource mutations rather
than implicit costs or metadata-driven setup execution.

## Independent inputs and committed steps

Keep independent choices in `inputs: { ... }` and submit them together. Use
`phase.steps().input(key, collector).input(key, ({ selected }) => collector)` only
when a later domain depends on earlier choices. The earlier selected values are
typed; duplicate keys and RNG input collectors are excluded.

Every completed step is committed private server state. A many selection is one
atomic step. Use explicit null for a no-target value. On an accepted state change,
revalidate in order: retain the valid prefix and drop from the first invalid
value onward. Unavailable interactions and every actual phase entry clear pending
choices, including leave/reenter of the same phase name. Reconnect and checkpoint
restore preserve persisted choices; restore does not replay the reducer.

The final command validates all accumulated params, then executes the reducer
once. Rejection retains the earlier persisted prefix and discards transaction/RNG
changes. A blocked current domain can still allow cancellation. Do not recreate
dependency graphs or client-side command replay.

## Selected-seat projection and events

Author one record-valued view. Include public facts and only that seat's allowed
private facts. Spectator custom view is empty; never pick a player as fallback.
The own key boards is reserved for manifest-derived static geometry. Transport
accepts object/null views, not primitive/array views. Ordinary memoize(fn) caches a
single object argument with WeakMap identity; there is no injected resolver.

`tx.emit` emits **public display events only**. The latest accepted outer operation
replaces runtime.events, including events from automatic entries. Empty step or
cancel operations clear the batch. Rejection preserves the old batch. Private
messages belong in the authored seat view. Do not store hidden card/resource
identities in public display details.

## Execution boundary

`app/index.ts` exports `createReducerBundle(game)`. Its contract contains
reducerContractVersion, initialize, dispatch, project and boardStatic. Use the
published `/reducer` ABI and schemas, and root canonical protocol types/schemas at
host boundaries; do not import private source paths or maintain parallel DTOs.

The offline host persists authoritative state before publishing a projection.
Reducer execution lives in a terminable worker inside a separate opaque iframe.
Keep progression in serialized state; module globals, wall-clock reads,
Math.random and network requests are not game authority. Seeded transaction RNG
makes replay deterministic; rejection consumes no accepted randomness.
