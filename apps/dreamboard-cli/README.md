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
dreamboard auth login
```

The CLI stores your refreshable session in `~/.dreamboard/auth.json` by default. The file is written atomically with owner-only permissions (`0600`).

The operating system keychain is optional. Set `"credentialBackend": "keychain"` in `~/.dreamboard/config.json`, or use `DREAMBOARD_CREDENTIAL_BACKEND=keychain`, to opt in.

That stored session includes the Clerk refresh token the CLI needs to renew and exchange for short-lived Dreamboard API tokens automatically. Direct JWT injection is intentionally not part of the published CLI flow.

## Source Checkout Setup

For local source-checkout development, install workspace dependencies with pnpm and keep Bun available for local embedded-harness workflows:

```bash
pnpm install
```

Playwright (for local dev-host verification):

```bash
npx playwright install
```

## Commands

Create a new game:

```bash
dreamboard project create my-game --description "A trick-taking card game"
```

Clone an existing project:

```bash
dreamboard project clone my-game
```

Commit and push authored changes with Git:

```bash
git add .
git commit -m "Update game"
git push
```

Inspect server state for an exact commit:

```bash
dreamboard project status --commit HEAD --wait
```

Verify an exact commit:

```bash
dreamboard verify --commit HEAD
```

Build or preview a pushed commit:

```bash
dreamboard build --commit HEAD
dreamboard preview --commit HEAD
```

Run tests:

```bash
dreamboard test
dreamboard test --scenario test/scenarios/main.scenario.ts
```

Start the local dev host:

```bash
dreamboard dev
```

## Notes

- Project state lives in `.dreamboard/project.json`.
- Published/public CLI installs target Node 20+ and support commit-scoped
  build, preview, release, and status workflows.
- Published stable CLI builds are production-only and do not support environment overrides or direct JWT injection. Published alpha builds allow `--env <local|staging|prod>` for operator verification, but still reject direct JWT injection.
- Local embedded-harness testing remains Bun-only and requires a source checkout with local backend support.
- Internal source-checkout builds may expose extra auth and environment helpers, but those are not part of the published CLI contract.

## Skill Source

- Public skill source lives under `skills/dreamboard/`.
- `skills/dreamboard/references/*.md` are generated from `docs/` via `pnpm run sync:skill-docs`.
- `dreamboard project create` installs the bundled skill into `.agents/skills/dreamboard/` in the generated game project.
- Public GitHub repo for the CLI is [dreamboard-games/dreamboard-cli](https://github.com/dreamboard-games/dreamboard-cli).
