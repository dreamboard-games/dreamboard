# Offline development host

Run `dreamboard-dev` in a game project with `manifest.ts`, `app/index.ts` and `ui/index.tsx`. The reducer entry exports `createReducerBundle(game)`. The UI entry owns its React root and `iframeSource()` provider; it imports the executable game only as a type. Styles are authored imports, with no SDK component stylesheet.

Options: `--port 5173`, `--players 2`, `--seed 1`, and `--options '{"target":10}'`. Game model schemas validate initialization options. The host uses `compileManifest(manifest).createInitialTable` for component initialization; phase transactions own seeded shuffle/deal behavior.

Install a matching published SDK/runtime/dev-host cohort. React UIs also require React, React DOM and `@tanstack/react-store@0.11.1`. The launcher bundles the reducer and UI independently and runs them in separate opaque frames. The reducer executes in a fresh terminable worker for each operation. Authored code cannot fetch network resources or access host storage.

The seat selector replaces the UI lifetime. Reset initializes the same seed and options. Save checkpoint and Restore checkpoint use trusted-host JSON state, including committed selections and RNG, with no replay on restore. Local storage resumes a source revision, seed, roster and options after refresh; refresh still requires the loopback server. The selected seat's projection is the only game data delivered to the UI.
