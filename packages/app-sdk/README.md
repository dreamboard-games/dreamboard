# @dreamboard-games/app-sdk

Reducer authoring SDK for Dreamboard game logic.

This package is published as `@dreamboard-games/app-sdk`. Dreamboard workspaces
and the CLI may install it through the npm alias `@dreamboard/app-sdk` so
authored source can use stable import paths.

## Main Surface

```ts
import { defineGame, definePhase, pipe } from "@dreamboard/app-sdk/reducer";
```

Use `@dreamboard/app-sdk/reducer` to define reducer-native games, phases,
interactions, prompts, setup profiles, views, derived values, board targets,
and runtime instructions. The reducer owns game legality and state changes; UI
code consumes projected descriptors and should not recompute rules.

