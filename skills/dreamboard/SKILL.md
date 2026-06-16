---
name: dreamboard
description: Create multiplayer, rule-enforced, turn-based game on Dreamboard.games platform.
metadata:
  short-description: Dreamboard Game Development Workflow
  tags: [dreamboard, cli, game-dev, board-game, turn-based, multiplayer]
---

# Dreamboard CLI

## Goal

Create and iterate on a Dreamboard game locally, then sync authored changes,
compile, run, and test against the current reducer-native scaffold.

## Prereqs

- Dreamboard CLI installed and available as `dreamboard`
  Install with `npm install -g dreamboard`
- Authenticated via `dreamboard login`

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

- `dreamboard sync`
  Upload local authored changes and advance the remote authored head. Run this after editing `rule.md`, `manifest.json`, or authored source files that should be part of the next remote build.
- `dreamboard compile`
  Compile the current remote authored head. Run this after `sync`, or re-run it after a failed compile when you have not made new authored edits.
- `dreamboard pull`
  Reconcile remote authored changes into the current workspace. Run this when someone else advanced the remote authored head or `dreamboard status` shows authored state `behind` or `diverged`.

Quick rule:

- edited files locally: `dreamboard sync` then `dreamboard compile`
- compile failed but you have not edited files since: `dreamboard compile` again
- remote authored head moved: `dreamboard pull` first

## Workflow

Use this order by default:

1. Write or revise `rule.md`.
2. Align `manifest.json` to the rules.
3. Run `dreamboard sync`.
4. Implement reducer state, phases, actions, and views in `app/`.
5. Implement the playable UI in `ui/App.tsx`.
6. Run `dreamboard compile`.
7. Generate test artifacts with `dreamboard test generate`.
8. Run scenarios with `dreamboard test run`.
9. Validate the local runtime with `dreamboard run`.
10. For agent-built games, run `dreamboard dev` and verify the browser UI before handoff. Use Playwright to open the dev host, check that the plugin iframe renders without console errors, and click a primary interaction such as selecting a playable hand card. Reducer scenarios alone are not enough when the game has an interactive UI.

## Guardrails

- `manifest.json` and `rule.md` are the source of truth for scaffolding.
- Run `dreamboard sync` after authored changes to keep generated files and the remote authored head in sync.
- `dreamboard pull` reconciles authored divergence into the current workspace.
- `dreamboard compile` is separate from authored sync; failed compiles do not mean the workspace needs a pull or another sync unless you changed authored files again.
- Use `dreamboard status` to distinguish authored sync from compile health before deciding whether the next command should be `sync`, `compile`, or `pull`.
- Re-run `dreamboard test generate` after runtime-shape changes in `manifest.json` or `app/`.
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

## Framework Feedback

Use `feedback.md` in the game project root to record framework issues, missing features, or workflow friction. Include reproduction steps, expected behavior, and actual behavior when possible.
