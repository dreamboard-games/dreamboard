---
name: dreamboard
description: Author, render, and verify Dreamboard TypeScript games with the headless SDK and offline development host.
---

Read the project's `rule.md`, package scripts and installed SDK declarations first.
Use a matching published SDK/dev-host release. The supported SDK entrypoints are
root, `/react`, `/reducer` and `/testing`; UI components are application-owned
source, not a styled SDK package.

The normal layout is `manifest.ts`, `app/game.ts`, `app/index.ts`, `ui/game.tsx`
(or `.ts`), `ui/App.tsx`, and the authored `ui/index.tsx`. Bind authoring with
`createGame(model)`. Bind UI with `createGameHook<Game>()(...)`; import Game only
as a type in hosted UI modules. The UI entry creates `iframeSource()` and passes
it to GameProvider. Executable reducer/testing imports belong in the reducer or
a separate local scenario entry, never in the hosted UI graph.

Run project `pnpm check`, then `pnpm dev` for the local host. Refresh after edits.
Exercise accepted/rejected actions, each seat, checkpoint restore, reset and the
ending. The host owns reducer execution and persistence; the UI receives only the
selected-seat projection. Keep imported media local for offline embedding.

Choose relevant references:

- [Quickstart](references/quickstart.md) and [first game](references/building-your-first-game.md): project layout and a coherent minimal example.
- [Local launcher](references/cli.md): actual options and offline host behavior.
- [Rules](references/rule-authoring.md), [manifest](references/manifest-authoring.md), [reducer](references/reducer.md): authoritative authoring.
- [Interface](references/game-interface.md): typed headless objects, React and privacy.
- [Testing](references/testing.md): scenarios, controlled request proofs and real browsers.

Use project-local offline commands. This skill does not authorize publishing,
remote deployment, or credential operations; those are separate user tasks.
Do not replace published SDK dependencies with private workspace links.
