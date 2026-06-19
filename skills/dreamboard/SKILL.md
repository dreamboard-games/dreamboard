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

## Buliding Your First Game
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
- Canonical concepts:
  [references/canonical-concepts.md](references/canonical-concepts.md)

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
  `test/bases/*.base.ts`, `test/scenarios/*.scenario.ts`,
  `test/testing-types.ts`

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
  Regenerate derived test artifacts as needed and run offline reducer tests.
- `dreamboard dev [--from-scenario <id>]`
  Start the local dev host for browser validation.

Quick rule:

- edited files locally: commit them with Git and push the branch
- need server readback: `dreamboard project status --commit <rev> --wait`
- need exact local proof: `dreamboard verify --commit <rev>`
- need scenario proof: `dreamboard test`

## Workflow

Use this order by default:

1. Write or revise `rule.md`.
2. Align `manifest.json` to the rules.
3. Implement reducer state, phases, actions, and views in `app/`.
4. Implement the playable UI in `ui/App.tsx`.
5. Commit and push authored changes with Git.
6. Run `dreamboard project status --commit HEAD --wait`.
7. Run `dreamboard verify --commit HEAD`.
8. Run scenarios with `dreamboard test`.
9. Validate the local runtime with `dreamboard dev`.
10. For agent-built games, run `dreamboard dev` and verify the browser UI before handoff. Use Playwright to open the dev host, check that the plugin iframe renders without console errors, and click a primary interaction such as selecting a playable hand card. Reducer scenarios alone are not enough when the game has an interactive UI.

## Orchestrated Cursor Cloud Jobs

When `AGENTS.md` says the workspace is an orchestrated Dreamboard build job,
follow that local contract instead of the human-authenticated server-readback
workflow:

1. Implement the requested game changes.
2. Create a branch whose name includes the Dreamboard job id, and open one pull request targeting the default branch.
3. Run local `dreamboard test --json` and `dreamboard verify --commit HEAD --json` only as advisory checks when available.
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
- Run `dreamboard test` after runtime-shape changes in `manifest.json` or `app/`; it regenerates derived test artifacts automatically.
- Keep reducer-owned UI data in views; do not reintroduce the old `shared/ui-args.ts` pattern in new scaffolds.
- When a game exposes clickable hands, markets, boards, or prompts, prove the same interaction works through `dreamboard dev` in a browser. A direct scenario submission can pass even when the rendered surface does not collect the input.
- For interactive card hands, render generated surfaces such as `handSurface.Hand` and `handSurface.Card` consistently. Do not swap a surface card for a raw `Card` or custom tile based on `me.canAct`; the surface primitive is responsible for disabling unavailable interactions.
- For scorecards, grids, and compact tracks, use board topology and generated board surfaces. Do not invent a separate sheet model or duplicate cell state outside reducer authority.
- Derive inventory from `manifest.json` and generated manifest helpers instead of declaring cards, dice, pieces, resources, or boards twice.
- Use reducer-owned terminal outcomes for final results. Do not infer winners in UI from a `winnerPlayerId` convention or score sorting.
- Display descriptor availability and reducer-projected disabled reasons. Do not reimplement action legality in React.
- Model solo procedures and automa rivals as deterministic reducer phases, state transitions, and game events. Do not create fake player seats for non-human behavior.
- Start from the smallest matching canonical reference game before inventing framework structure. See [references/canonical-concepts.md](references/canonical-concepts.md).

## Editable Surface

Edit:

- `rule.md`
- `manifest.json`
- `app/game-contract.ts`
- `app/game.ts`
- `app/phases/*.ts`
- `app/setup-profiles.ts`
- `ui/App.tsx`
- `test/bases/*.base.ts`
- `test/scenarios/*.scenario.ts`

Do not edit generated or framework-owned files such as:

- `app/index.ts`
- `shared/manifest-contract.ts`
- `shared/generated/ui-contract.ts`
- `ui/index.tsx`
- `test/generated/*`

## Offical Documentation
Visit https://dreamboard.games/docs
