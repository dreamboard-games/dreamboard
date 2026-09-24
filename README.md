# Dreamboard authoring

Author games as ordinary TypeScript projects. Run `pnpm check` for the project's TypeScript and Vitest checks, and `pnpm dev` to play locally in a browser. Local play requires no login or backend.

This repository owns `@dreamboard-games/browser-gameplay-runtime`, `@dreamboard-games/dev-host`, public documentation, and agent skills. The SDK is a published dependency from the separate SDK repository.

The former product CLI, its auth/session storage, source synchronization, remote build/preview/release commands, and API client have been removed. Publication belongs to the product's reviewed upload flow.

## Local authoring

A game contains `manifest.ts`, `app/game.ts` exporting its game definition, and a hosted `ui/index.tsx` mounting `ui/App.tsx`. Install a matching published SDK and dev-host release, with project scripts:

```json
{
  "scripts": { "check": "tsc --noEmit && vitest run", "dev": "dreamboard-dev" }
}
```

Run `pnpm dev --players 2 --seed 1`. Refresh the page after editing source to rebuild it. The host saves the full session in browser storage and resumes the same source revision, player count, and seed. Use Reset game to start again. Switching seats remounts the UI so component state from a prior perspective is cleared.

Imported images and fonts are embedded in the bundle. Remote asset URLs and network calls are blocked inside authored code; bring media into the project before relying on offline play. Local play remains available after the page has loaded even when the network is disconnected. Reloading the host page requires the local dev server.

## Repository verification

Use Node 24 and pnpm. `pnpm check` builds the public packages and executes browser runtime tests. Install both engines with `pnpm --dir packages/browser-gameplay-runtime exec playwright install chromium webkit`; local Chromium runs use installed Chrome.

`pnpm verify:package` creates tarballs and a SHA-512 receipt under `build/release-candidate` and verifies package identities, compiled entrypoints, and the installed candidate in Chromium and WebKit. Commit all source changes first: candidate packing rejects a dirty working tree, and publication requires the same source commit and exact tarball integrities. The manually dispatched release workflow uploads this immutable candidate for review. Its explicit `publish` input enables npm publication through the protected release environment, rechecking exact registry integrity before and after publishing.

The no-generated-source authoring API is being delivered in the corresponding SDK change. This branch uses the real published SDK `0.5.0-alpha.1` until that candidate is published and repinned; do not substitute a private workspace SDK dependency.

The next reserved public cohort is browser runtime `0.1.0-alpha.2` and dev-host
`0.2.0-alpha.2`, targeting SDK `0.5.0-alpha.3`. Publish the SDK first, then repin
both public packages to that exact npm version and refresh the lockfile before
verification. The current SDK dependency remains unchanged until publication.
The dev-host's `workspace:*` runtime dependency is rewritten by `pnpm pack` to the
exact candidate runtime version; candidate verification enforces that match.

The SDK has four facades: root for headless instances/sources/protocol, `/react`
for the optional React adapter, `/reducer` for authoring/execution, and `/testing`
for local scenario tooling. Hosted UI imports executable code only from root and
`/react`; its game definition import must be type-only.
