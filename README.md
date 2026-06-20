# dreamboard

Dreamboard for working with Dreamboard games from your own editor/tooling.

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

The published `dreamboard` package targets Node 20+.

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

Dreamboard stores your refreshable session in the Dreamboard credential
store. Direct JWT injection is intentionally not part of the published Dreamboard flow.

```bash
dreamboard auth status
```

## Source Checkout Setup

For local source-checkout development, install workspace dependencies with pnpm and keep Bun available for local embedded-harness workflows:

```bash
pnpm install
```

Playwright is only needed for browser-oriented local checks:

```bash
npx playwright install
```

## Commands

Create a project workspace:

```bash
dreamboard project create my-game --description "A trick-taking card game"
```

Clone an initialized project repository:

```bash
dreamboard project clone owner/my-game
```

Work with native Git as the source-control boundary:

```bash
git status --porcelain=v2 --branch
git diff --check
git add -A
git diff --cached --check
git commit -m "Implement scoring changes"

dreamboard verify --commit HEAD
git push --porcelain --set-upstream origin HEAD
dreamboard project status --commit HEAD --wait
```

Run authored tests:

```bash
dreamboard test
dreamboard test --scenario test/scenarios/player-two-wins.scenario.ts
dreamboard test --runner browser
dreamboard test --runner remote --commit HEAD
```

Build, preview, and publish exact commits:

```bash
dreamboard build --commit HEAD
dreamboard preview --commit HEAD
dreamboard release publish --commit HEAD --yes
dreamboard release current
```

Start the local development host:

```bash
dreamboard dev
```

## Notes

- Project state lives in `.dreamboard/project.json`.
- Published/public `dreamboard` installs target Node 20+ and support remote workflows.
- Published/public `dreamboard` builds are production-only; they do not support environment overrides or direct JWT injection.
- Local embedded-harness testing remains Bun-only and requires a source checkout with local backend support.
- Internal source-checkout builds may expose extra auth and environment helpers, but those are not part of the published Dreamboard contract.

## Skill Source

- Public skill source lives under repo-root `skills/dreamboard/`.
- Install the public skill directly with `skills.sh`:

```bash
npx skills add https://github.com/dreamboard-games/dreamboard --skill dreamboard
```

## Publish Prep

Build a staged public package:

```bash
pnpm run stage:publish
pnpm run pack:publish
```

`stage:publish` creates `.publish/package` as the public npm artifact for package name `dreamboard`, including the public `skills/dreamboard` tree.

Optional public metadata env vars for staging:

```bash
export DREAMBOARD_PUBLIC_REPOSITORY_URL="https://github.com/<org>/<repo>.git"
export DREAMBOARD_PUBLIC_HOMEPAGE="https://github.com/<org>/<repo>"
export DREAMBOARD_PUBLIC_BUGS_URL="https://github.com/<org>/<repo>/issues"
export DREAMBOARD_PUBLIC_LICENSE="MIT"
```

If the source package already defines `repository`, `homepage`, `bugs`, or `license`, `stage:publish` will reuse those fields automatically.

Before creating GitHub PRs or releases, verify `gh` is authenticated to the account you intend to use:

```bash
gh auth status
```

If the wrong account is active, switch first:

```bash
gh auth switch -u <github-user>
```
