# dreamboard

Dreamboard CLI for working with Dreamboard games from your own editor/tooling.

Dreamboard is built to take you from napkin sketch to playable prototype without the paper cuts:

- Describe the game you want to make.
- Generate the rules, components, and scaffolding.
- Playtest instantly with a frictionless lobby and live iteration loops.

The platform’s core promise is the same one described on the landing page: digital prototyping for everyone, with AI helping you move from idea to playable faster.

## Install

Published npm package:

```bash
npm install -g dreamboard
```

The published CLI targets Node 20+.

## Why Dreamboard

- `Describe`: start from theme, mechanics, and player experience instead of boilerplate setup.
- `Generate`: Dreamboard handles the sandbox primitives like turns, hands, and structured scaffolding.
- `Playtest`: share a live prototype instead of printing fresh paper every time a rule changes.
- `Iterate live`: keep testing momentum by changing values and flows without resetting the whole process.

## Authentication

Use browser login:

```bash
dreamboard login
```

The published CLI stores your refreshable session in the operating system credential store via `@napi-rs/keyring`. It does not fall back to plaintext `~/.dreamboard/auth.json`.

That stored session includes the Clerk refresh token the CLI needs to renew and exchange for short-lived Dreamboard API tokens automatically. Direct JWT injection is intentionally not part of the published CLI flow.

## Source Checkout Setup

For local source-checkout development, install workspace dependencies with pnpm and keep Bun available for local embedded-harness workflows:

```bash
pnpm install
```

Playwright (for `dreamboard run`):

```bash
npx playwright install
```

## Commands

Create a new game:

```bash
dreamboard new my-game --description "A trick-taking card game"
```

Clone an existing game:

```bash
dreamboard clone my-game
```

Sync local authored changes and regenerate scaffolded files:

```bash
dreamboard sync
dreamboard sync --update-sdk
```

If the remote has advanced unexpectedly, reconcile authored changes explicitly with:

```bash
dreamboard pull
```

Compile the current authored head:

```bash
dreamboard compile
dreamboard compile --skip-local-check
```

Inspect local vs remote state:

```bash
dreamboard status
dreamboard status --json
```

Run the game locally (server-compiled UI):

```bash
dreamboard run
dreamboard run --players 4
dreamboard run --seed 1337
dreamboard run --new-session
```

If no successful compile exists for the current authored state yet, `dreamboard run` will ask you to run `dreamboard compile` first.
By default, the CLI uses `manifest.json`'s `playerConfig.minPlayers` to decide how many seats to create.

`dreamboard run` now defaults to a wait-and-observe loop when no scenario is provided:

1. Reuse the previous active session (`--resume` defaults to true) unless `--new-session` is set.
2. Subscribe to session SSE events.
3. Exit when `YOUR_TURN` (default `--until`) or `GAME_ENDED` is received.
4. Persist artifacts in `.dreamboard/run/`:
   - `session.json`
   - `events.ndjson`
   - `latest-your-turn.json`
   - `last-run-summary.json`

`dreamboard run` is deterministic-by-default for new sessions: if `--seed` is not provided, it uses `1337`.

Useful flags:

- `--until YOUR_TURN|GAME_ENDED|ANY`
- `--observe-events turns|all` (default `turns`; persist `YOUR_TURN` and `ACTION_REJECTED` messages)
- `--seed <int>` (deterministic RNG seed for new sessions, default `1337`)
- `--timeout-ms <ms>`
- `--max-events <count>`
- `--screenshot` (capture one Playwright screenshot for the selected run session)
- `--output <path>`
- `--delay <ms>`
- `--width <px>`
- `--height <px>`
- `--scenario-driver api|ui` (default `api`)

Playwright launch is now optional:

1. It is launched when `--scenario-driver ui` is used.
2. It is launched when `--screenshot` is used.
3. Default API scenarios (`--scenario` with `--scenario-driver api`) do not require Playwright.
4. Pure observe runs (`dreamboard run` without scenario/screenshot) do not require a browser session.

## Scenario Files

`dreamboard run --scenario <file>` supports scenario JSON (API driver by default):

```json
{
  "steps": [
    {
      "playerId": "player-1",
      "actionType": "playCard",
      "parameters": { "cardId": "hearts-7" },
      "turns": 1
    },
    {
      "playerId": "player-1",
      "actionType": "endTurn",
      "parameters": {},
      "turns": 1
    }
  ]
}
```

`playerId` is required on every scenario step. The CLI executes all steps in order per invocation:

```bash
dreamboard run
dreamboard run --scenario path/to/scenario.json
dreamboard run --scenario path/to/scenario.json --scenario-driver ui
```

If there is no current `.dreamboard/run/latest-your-turn.json` for the active session (for example with `--new-session`), `dreamboard run --scenario ...` first observes SSE until it receives the initial `YOUR_TURN`, then starts executing scenario steps.

API-driven scenarios are strict per step: after each `submitAction`, the CLI waits for either `ACTION_EXECUTED` or `ACTION_REJECTED`. On rejection, it stops immediately with `stopReason=scenario_rejected`.

Screenshots are saved to `.dreamboard/screenshots/` by default. The CLI captures the same session selected by `--resume` / `--new-session`.

To capture a screenshot during observe or scenario runs:

```bash
dreamboard run --screenshot
dreamboard run --scenario path/to/scenario.json --screenshot
dreamboard run --screenshot --output ./shot.png --delay 1500 --width 1440 --height 900
```

## Notes

- Project state lives in `.dreamboard/project.json`.
- Snapshots for `status` are stored in `.dreamboard/snapshot.json`.
- Published/public CLI installs target Node 20+ and support remote workflows.
- Published/public CLI builds are production-only; they do not support environment overrides or direct JWT injection.
- Local embedded-harness testing remains Bun-only and requires a source checkout with local backend support.
- Internal source-checkout builds may expose extra auth and environment helpers, but those are not part of the published CLI contract.

## Skill Source

- Public skill source lives under `skills/dreamboard/`.
- `skills/dreamboard/references/*.md` are generated from `docs/` via `pnpm run sync:skill-docs`.
- `dreamboard new` installs the bundled skill into `.agents/skills/dreamboard/` in the generated game project.
- The Node helper script for run-artifact inspection is `.agents/skills/dreamboard/scripts/events-extract.mjs`.
- Public GitHub repo for the CLI is [dreamboard-games/dreamboard-cli](https://github.com/dreamboard-games/dreamboard-cli).
