# Repository Guidelines

This repository owns the public browser gameplay runtime, offline development host, docs, and agent skills. The SDK is consumed as a published npm package.

Use Node 24 and pnpm. Run `pnpm check` before handoff and `pnpm verify:package` for package/release changes. Browser tests use installed Chrome locally and Playwright Chromium in CI.

Keep authored reducers in a terminable worker inside an opaque iframe. Keep authored UI in a separate opaque iframe. Full reducer state belongs only to the trusted host and its persistence callback; only the selected-seat projection crosses the UI bridge. Do not add login, remote sync/build/preview/release APIs, or a second local engine.
