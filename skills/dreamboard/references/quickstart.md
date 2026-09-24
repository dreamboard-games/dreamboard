# Quickstart

Install the matching published SDK and dev-host cohort declared by the project.
React UIs also need `react`, `react-dom` and the SDK's exact optional renderer peer
`@tanstack/react-store@0.11.1`. Reducer authoring uses Zod. Preserve existing pinned
versions; do not guess a prerelease or repin as part of ordinary game edits.

```json
{
  "scripts": {
    "check": "tsc --noEmit && vitest run",
    "dev": "dreamboard-dev"
  }
}
```

Keep these ownership boundaries:

- `manifest.ts`: players, cards, zones and inline static board data.
- `app/game.ts`: bound model, phases, transactions and one selected-seat view.
- `app/index.ts`: default `createReducerBundle(game)` export.
- `ui/game.tsx`: typed React hook using a type-only game import.
- `ui/App.tsx`: ordinary components accepting a source.
- `ui/index.tsx`: mounts the authored UI with `iframeSource()`.
- Optional separate local entry: imports game and `/testing` to create a local or
  scenario source; keep it outside the hosted UI import graph.

Run `pnpm check`, then `pnpm dev --players 2 --seed 1`. Use the displayed local URL.
Switch seats and verify privacy, reset, save/restore and terminal behavior.
Refresh after changes so the host compiles the new revision. Imported local
images/fonts are embedded; authored frames cannot make remote network requests.

See [first game](building-your-first-game.md) for a complete small authoring
example and [interface](game-interface.md) for the actual React entries.
