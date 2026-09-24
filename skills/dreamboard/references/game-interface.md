# Headless interface

The offline host compiles your authored `ui/index.tsx`. Hosted modules import the
assembled game only as a type. This binding works with the counter in
[first game](building-your-first-game.md).

`ui/game.tsx`:

```tsx
import type { ReactElement } from "react";
import { createGameHook } from "@dreamboard-games/sdk/react";
import type definition from "../app/game";

export const { GameProvider, useGame, Subscribe } = createGameHook<
  typeof definition
>()({
  coverage: { "play.increment": Counter },
});
export function Counter(): ReactElement | null {
  const view = useGame((game) => game.view);
  const increment = useGame((game) => game.interactions.get("play.increment"));
  if (!view) return <p>Connecting…</p>;
  return (
    <main>
      <h1>Counter</h1>
      <output>{view.count}</output>
      {increment && <button {...increment.getSubmitProps()}>Add one</button>}
    </main>
  );
}
```

`ui/App.tsx`:

```tsx
import type { GameSource } from "@dreamboard-games/sdk";
import { GameProvider, Counter } from "./game";
export function App({ source }: { source: GameSource }) {
  return (
    <GameProvider source={source}>
      <Counter />
    </GameProvider>
  );
}
```

`ui/index.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { iframeSource } from "@dreamboard-games/sdk";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(
  <App source={iframeSource()} />,
);
```

GameProvider owns source disposal. Bind the hook without a source; each mounted
provider receives its own source. A separate local scenario entry may pass
`await localSource(definition, options)` or `await scenarioSource(...)` to App.
Only that local entry imports the executable definition and `/testing`.

## Objects and selections

`useGame()` returns the stable instance; selector form subscribes to immutable
snapshots. Select scalars or stable branches. `phase`, `turn`, `me`, `players`,
`interactions`, `inputs`, `zones`, `cards` and `events.recent` describe the selected
seat. `turn.currentPlayerId` is null when zero or multiple players are active;
`turn.isMine` is active membership. `me.getCanAct()` checks available legal actions.

Use canonical field/target/submit props for native controls. Local input values
can be unfinished; readiness and disabled props reflect canonical constraints.
For ordered interactions, render only current inputs, display saved step.selected
separately, and require a new intent for the next step. reset clears a local draft;
cancel clears the server prefix, including when the current domain is blocked.
Programmatic submit/cancel returns accepted:false for rejection: inspect the
result, not just exceptions. Show errors using current onError or application UI.

A successful ACK may precede its frame. Let the source request barrier manage
submitting and exact-revision draft clearing; never advance steps from an ACK
alone. Source/seat replacement invalidates old handlers and selections.

## Features, styling and privacy

Enable optional handFeature/boardFeature/dragFeature/panZoomFeature in the hook's
features callback. Disabled APIs are absent from types. Static boards come from
canonical materialized frame.view.boards; arbitrary authored view fields cannot
replace that reserved authority. Occupancy is ordinary selected-seat view data.

Components/styles are application-owned or copied from the source registry.
Workspace-bound items import `useGame` through the configured `@game` alias.
Keep keyboard semantics, touch hit areas and accessible labels. Animation is
optional app behavior. Native wheel zoom needs a non-passive listener, and SVG
pointer coordinates must be converted through the screen CTM.

Never infer hidden card faces from manifest IDs or forward full checkpoints to
the UI. Card view is null when hidden. Opponents' counts are not permission to read
their cards. The host uses a separate opaque UI iframe from reducer execution.
The latest public event batch is not a private-message channel or replay stream.
