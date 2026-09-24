# Offline launcher

`@dreamboard-games/dev-host` supplies `dreamboard-dev`. A game normally exposes it
as `"dev": "dreamboard-dev"` in package scripts:

```sh
pnpm dev --players 2 --seed 1 --options '{}'
```

| Option      | Default | Meaning                                            |
| ----------- | ------- | -------------------------------------------------- |
| `--port`    | `5173`  | Loopback HTTP port                                 |
| `--players` | `2`     | Local seat count, within manifest bounds           |
| `--seed`    | `1`     | Deterministic initialization seed                  |
| `--options` | `'{}'`  | JSON object validated by the game's options schema |
| `--help`    | —       | Print launcher usage                               |

Run from the project containing `manifest.ts`, `app/index.ts` (default reducer
bundle export), and authored `ui/index.tsx`. The launcher compiles that UI entry
directly; it does not supply a React wrapper. Refresh after source edits.

The local host switches seats, resets the game, saves/restores JSON checkpoints,
and resumes matching localStorage sessions. Checkpoints include full private
state and belong to trusted local developer controls; never send them to the
UI iframe. The selected-seat frame crosses the bridge separately.

`pnpm check` is project-owned, normally TypeScript plus Vitest. Programmatic
inspection/exploration uses `/testing` localSource/scenarioSource, not launcher
subcommands. No login or remote project is required. After loading, play remains
local; reloading still needs the development server.
