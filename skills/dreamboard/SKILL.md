---
name: dreamboard
description: Author and verify Dreamboard TypeScript games with project-local check and offline dev scripts.
---

Read the project's rules and package scripts first. The authored layout is `manifest.ts`, `app/game.ts`, and `ui/App.tsx`. Use the installed published SDK's reducer, runtime, and testing APIs.

Run `pnpm check` for TypeScript and Vitest proof. Run `pnpm dev` for the local browser host; it requires no login or backend. Refresh after editing source. Test each seat, accepted and rejected interactions, reset, and terminal outcomes. Keep media local and imported; network requests from authored code are blocked.

Never restore the retired product CLI's auth, sync, remote build, preview, or release workflow. Publication is a separate product action. Do not use private workspace SDK links as a substitute for a published release.

Read [quickstart](references/quickstart.md), [local launcher](references/cli.md), and [testing](references/testing.md) for the workflow. Consult SDK reference documents for authoring types.
