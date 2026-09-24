`@dreamboard-games/dev-host` provides one local launcher, `dreamboard-dev`. Invoke it through the game's `pnpm dev` script.

| Option      | Default | Purpose                  |
| ----------- | ------- | ------------------------ |
| `--port`    | `5173`  | Loopback HTTP port       |
| `--players` | `2`     | Number of local seats    |
| `--seed`    | `1`     | Deterministic setup seed |

The launcher reads `manifest.ts`, `app/game.ts`, and `ui/App.tsx` from the working directory. It bundles on page load. Refresh the browser after edits.

`pnpm check` is owned by the game project, normally `tsc --noEmit && vitest run`. There is no global product CLI and no login, sync, remote build, preview, or release command.
