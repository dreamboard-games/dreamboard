---
name: dreamboard
description: Create multiplayer, rule-enforced, turn-based game on Dreamboard.games platform.
metadata:
  short-description: Dreamboard Game Development Workflow
  tags: [dreamboard, cli, game-dev, board-game, turn-based, multiplayer]
---

# Dreamboard

## Goal

Create and iterate on a Dreamboard game locally with the Git-native Dreamboard
command, then verify exact commits, run tests, and use the local dev host.

## Prereqs

- Dreamboard installed and available as `dreamboard`
  Install with `npm install -g dreamboard`
- Authenticated via `dreamboard auth login`

## Building Your First Game

See [tutorials/building-your-first-game.md](references/building-your-first-game.md)

## References

- Quickstart:
  [references/quickstart.md](references/quickstart.md)
- Tutorial:
  [references/building-your-first-game.md](references/building-your-first-game.md)
- CLI:
  [references/cli.md](references/cli.md)
- Rules:
  [references/rule-authoring.md](references/rule-authoring.md)
- Manifest:
  [references/manifest-authoring.md](references/manifest-authoring.md)
- Reducer:
  [references/reducer.md](references/reducer.md)
- Game interface:
  [references/game-interface.md](references/game-interface.md)
- Testing:
  [references/testing.md](references/testing.md)

## Current Scaffold

The current scaffold centers on these files:

- authored source:
  `rule.md`, `manifest.json`
- reducer:
  `app/game-contract.ts`, `app/game.ts`, `app/phases/*.ts`,
  `app/setup-profiles.ts`
- UI:
  `ui/App.tsx`
- tests:
  `test/testing-types.ts`, `test/scenarios/*.scenario.ts`

## Command Flow

Use the commands for different kinds of state:

- `dreamboard project create <slug> --description <text>`
  Create a project workspace and configure its Git remote.
- `dreamboard project clone <project>`
  Clone an existing project repository.
- `dreamboard project status --commit <rev> [--wait]`
  Read server state for one exact commit.
- `dreamboard verify --commit <rev>`
  Verify one exact commit from a detached worktree.
- `dreamboard test`
  Replay authored scenarios and emit one semantic JSON result.
- `dreamboard test inspect <path> --perspective <value>`
  Observe one node in an authored scenario replay.
- `dreamboard test explore <path> --perspective <value>`
  Enumerate canonical accepted commands from that node.
- `dreamboard dev [--from-scenario <path>] [--at <node>]`
  Start the local dev host for browser validation.

Quick rule:

- edited files locally: commit them with Git and push the branch
- need server readback: `dreamboard project status --commit <rev> --wait`
- need exact local proof: `dreamboard verify --commit <rev>`
- need scenario proof: `dreamboard test`

## Agent-first scenario loop

Use one persistent proof format: one default-exported scenario per
`test/scenarios/**/*.scenario.ts` file. A scenario declares normal
`setup: { players, seed, setupProfileId? }`, serializable accepted `given` and
`when` command arrays, and typed `then` assertions. Actors and semantically
player-valued parameters use `{ seat: <zero-based-seat> }` references.

Start with empty command arrays when necessary, then use this loop:

```bash
# Observe the node after the authored `given` prefix.
dreamboard test inspect test/scenarios/complete-game.scenario.ts \
  --perspective player:0

# Enumerate accepted concrete commands from a selected node.
dreamboard test explore test/scenarios/complete-game.scenario.ts \
  --perspective player:0 --at given:3 \
  --limit 50 --max-evaluations 5000

# Copy one result.candidates[].command into `given` or `when`, then prove it.
dreamboard test --scenario test/scenarios/complete-game.scenario.ts

# Optionally continue visually from the same normal replay prefix.
dreamboard dev \
  --from-scenario test/scenarios/complete-game.scenario.ts \
  --at given:3
```

The entire `test` family emits exactly one newline-terminated JSON envelope to
stdout by default. Successful stderr is empty. Recognized failures also emit
one envelope to stdout, leave stderr empty, and exit nonzero. Branch on stable
`problem.code` and typed `problem.context`, never prose.

`inspect` and `explore` require exactly one perspective:

- `player:<zero-based-seat>` returns only that player's normal view,
  descriptors, explanations, and commands.
- `spectator` returns the spectator view and no player commands.

Query each acting seat independently. Never try to combine player views.

`--at` accepts only `setup`, `given:<n>`, or `when:<n>`. `n` is a completed
command count. The observation default is the end of `given`.

`inspect` reports visible `interactions`, performable `actions`, scheduler-owned
flow diagnostics, and structured entropy for the selected perspective.
`explore` materializes complete inputs, dispatches each candidate on a fresh
clone, and returns only accepted `candidates[].command` objects in the exact
seat-based source shape. Copy one into the scenario without translating it.

Transition exploration is deterministic:

- `--limit` defaults to 50 and accepts 1 through 200.
- `--max-evaluations` defaults to 5,000 and accepts 1 through 5,000.
- `--cursor '<nextCursor>'` requests the next page. Cursors become stale when
  source, checkpoint, perspective, seed, or enumeration authority changes.

For runtime-owned randomness, use diagnostic seed overrides:

```bash
dreamboard test explore test/scenarios/complete-game.scenario.ts \
  --perspective player:0 --at setup --seed-range 1:64
dreamboard test inspect test/scenarios/complete-game.scenario.ts \
  --perspective player:0 --at setup --seed 17
```

`--seed-range <start>:<end>` is inclusive, ascending, safe-integer only, and
limited to 64 seeds. `--seed <safe-integer>` and `--seed-range` cannot be
combined. Persist the chosen seed in `scenario.setup.seed`; an override alone
is not test authority.

Stable test-family failure codes:

- `TEST_SCENARIO_NOT_FOUND`
- `TEST_SCENARIO_DUPLICATE_ID`
- `TEST_SCENARIO_INVALID`
- `TEST_CHECKPOINT_INVALID`
- `TEST_SCENARIO_REPLAY_REJECTED`
- `TEST_SCENARIOS_FAILED`
- `TEST_PERSPECTIVE_INVALID`
- `TEST_SEED_RANGE_INVALID`
- `TEST_EXPLORE_CURSOR_STALE`
- `TEST_EXPLORE_LIMIT_INVALID`
- `TEST_JSON_EVENTS_UNSUPPORTED`
- `TEST_UNEXPECTED`

Use clone-only `probe(command)` inside `then` for typed rejection assertions.
Do not hydrate or patch reducer state, author runtime player IDs, persist
inspect/explore output, or add a separate test setup path.

## Workflow

Use this order by default:

1. Write or revise `rule.md`.
2. Align `manifest.json` to the rules.
3. Implement reducer state, phases, actions, and views in `app/`.
4. Implement the playable UI in `ui/App.tsx`.
5. Author the rule path in one reducer scenario.
6. Use `test inspect` and `test explore` to extend the canonical command path.
7. Run scenarios with `dreamboard test`.
8. Validate the authored prefix with `dreamboard dev --from-scenario` and the
   browser UI.
9. Commit and push authored changes with Git.
10. Run `dreamboard project status --commit HEAD --wait` and
    `dreamboard verify --commit HEAD` for the pushed commit.

For agent-built games, verify the browser UI before handoff. Use Playwright to
open the dev host, check that the plugin iframe renders without console errors,
and click a primary interaction such as selecting a playable hand card.
Reducer scenarios alone are not enough when the game has an interactive UI.

## Orchestrated Cursor Cloud Jobs

When `AGENTS.md` says the workspace is an orchestrated Dreamboard build job,
follow that local contract instead of the human-authenticated server-readback
workflow:

1. Implement the requested game changes.
2. Create a branch whose name includes the Dreamboard job id, and open one pull request targeting the default branch.
3. Run local `dreamboard test` and `dreamboard verify --commit HEAD --json`
   only as advisory checks when available. Test output is already JSON.
4. Commit the finished changes.
5. Push only the pull-request branch and keep the pull request open.

If the runner continues the same thread with verifier diagnostics, make a
focused correction on the same pull request, create a new commit, and push the
updated branch again.

Do not run authenticated project status, preview, release, or accept commands
from an orchestrated build job. Do not edit `.github/**` or
`.dreamboard/control/**`. Authoritative verification runs after the Cursor job
finishes, and the runner and backend report final build and preview state after
the pull request passes independent verification.

## Guardrails

- `manifest.json` and `rule.md` are the source of truth for scaffolding.
- Use Git for source-control state transitions; Dreamboard does not stage,
  commit, pull, merge, branch, or push for you.
- Use `dreamboard project status --commit <rev>` for server state, not local Git status.
- Run `dreamboard test` after runtime-shape changes in `manifest.json` or
  `app/`; scenarios load their source dependency closure and replay the same
  production reducer path.
- Keep reducer-owned UI data in views; do not reintroduce the old `shared/ui-args.ts` pattern in new scaffolds.
- When a game exposes clickable hands, markets, boards, or prompts, prove the same interaction works through `dreamboard dev` in a browser. A direct scenario submission can pass even when the rendered surface does not collect the input.
- For interactive card hands, render generated surfaces such as `handSurface.Hand` and `handSurface.Card` consistently. Do not swap a surface card for a raw `Card` or custom tile based on `me.canAct`; the surface primitive is responsible for disabling unavailable interactions.

## Editable Surface

Edit:

- `rule.md`
- `manifest.json`
- `app/game-contract.ts`
- `app/game.ts`
- `app/phases/*.ts`
- `app/setup-profiles.ts`
- `ui/App.tsx`
- `test/testing-types.ts`
- `test/scenarios/*.scenario.ts`

Do not edit generated or framework-owned files such as:

- `app/index.ts`
- `shared/manifest-contract.ts`
- `shared/generated/ui-contract.ts`
- `ui/index.tsx`

## Offical Documentation

Visit https://dreamboard.games/docs
