# Repository Guidelines

## Architecture Boundaries

- `packages/cli-core` should stay a small, portable core for shared CLI primitives such as Git, auth/session status shapes, and command-result helpers. Keep full CLI framework, browser, React, Vite/dev-host, Playwright, UI runtime, and presentation concerns in `apps/dreamboard-cli` or the package that owns that runtime surface.
