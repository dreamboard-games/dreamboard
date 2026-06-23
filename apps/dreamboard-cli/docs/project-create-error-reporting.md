# Dreamboard CLI Project Create Error Reporting

## Status

Proposed

## Date

2026-06-23

## Owner

Dreamboard

## Problem Statement

`dreamboard project create` can currently fail with a low-level runtime message
instead of an operator-facing explanation:

```text
Error: undefined is not an object (evaluating 'response.status')
```

This message does not tell the user:

1. which `project create` phase failed;
2. whether Dreamboard reached an HTTP response at all;
3. which environment or API base URL was selected;
4. whether the recovery action is auth, local backend startup, remote retry, or
   slug/project cleanup; or
5. whether any remote project or local workspace was partially created.

The result is especially confusing in local development because
`pnpm cli:dev -- project create ...` defaults to the local Dreamboard API unless
`--env` or `--prod` changes the target. A missing local backend, stale local
session, repo provisioning issue, and API problem-details response should not
collapse into the same JavaScript property-access error.

## Current Behavior

The `project create` command already has distinct operational phases in
`apps/dreamboard-cli/src/commands/project-create.ts`:

1. load global config and stored session;
2. resolve config and require auth;
3. configure the API client;
4. prepare the local maintainer package snapshot;
5. resolve backend deployment and owner identity;
6. ensure the remote project;
7. ensure and poll the project repository; and
8. scaffold the local workspace and configure Git origin.

The generated API client in `packages/api-client/src/client/client.gen.ts`
returns an object with `response: undefined` when `fetch` throws before an HTTP
response exists. The CLI-side error normalization in
`apps/dreamboard-cli/src/utils/errors.ts` can already present
`DreamboardApiError` instances with HTTP status, request IDs, problem types, and
resolutions. The weak point is that not every failure path is normalized before
it reaches the fatal error handler.

## Goals

1. Replace raw runtime property-access failures with actionable CLI messages.
2. Preserve backend `ProblemDetails` data when the server returns it.
3. Treat transport failures with no response as a first-class user-facing case.
4. Name the failed `project create` phase in the default human output.
5. Keep machine output stable and structured for `--json` and `--json-events`.
6. Keep Dreamboard-specific API and environment guidance in
   `apps/dreamboard-cli`, not in portable `packages/cli-core`.

## Non-Goals

1. Do not move browser, React, Vite, Playwright, dev-host, or presentation logic
   into `packages/cli-core`.
2. Do not expose internal credential/token diagnostics in the default output.
3. Do not replace the generated API client wholesale.
4. Do not require backend API changes before improving the CLI message.

## Proposed Solution

Introduce a small CLI-owned operation context layer for commands that perform
multi-step remote work.

For `project create`, wrap each important phase with a helper that annotates
errors before they reach the fatal handler:

```ts
await withCliStep(
  {
    command: "project.create",
    step: "resolving backend identity",
    environment: config.environment,
    apiBaseUrl: config.apiBaseUrl,
  },
  () => loadRemoteProjectIdentity(),
);
```

The helper should:

1. pass through `DreamboardApiError` while adding step/environment context;
2. convert transport failures with no response into a Dreamboard CLI transport
   error;
3. preserve original `cause` for debugging;
4. provide a concise default message and optional structured details; and
5. avoid printing stack traces unless an explicit debug flag is enabled.

Example replacement message for a local backend that is not reachable:

```text
Error: Could not reach the Dreamboard API while creating project "sushi-go".
Step: resolving backend identity
Environment: local
API: http://localhost:8080
Resolution: Start the local Dreamboard backend, or run with --env staging / --prod if you meant to use a remote environment.
```

Example replacement message for an authenticated backend problem response:

```text
Error: Game slug already exists: sushi-go (HTTP 409)
Step: ensuring remote project
Environment: staging
Request ID: req_...
Resolution: Choose a different slug, or retry with --force if you intend to rebind the existing slug.
```

Example replacement message for repository provisioning timeout:

```text
Error: Repository setup for project <projectId> timed out after 120000ms.
Step: waiting for project repository
Environment: staging
Resolution: Retry project creation after repository provisioning recovers. If the project was created, run dreamboard project clone sushi-go instead of creating a second project.
```

## Implementation Plan

1. Add a CLI-owned error type or context wrapper in
   `apps/dreamboard-cli/src/utils/errors.ts`, such as `CliOperationError` or
   `withCliStep`.
2. Extend `presentCliError` so contextual CLI errors render:
   message, step, environment, API URL when useful, request ID, and resolution.
3. Harden API result normalization so `response === undefined` always becomes a
   transport problem instead of leaking to code that expects `response.status`.
4. Update `apps/dreamboard-cli/src/commands/project-create.ts` to wrap:
   local maintainer snapshot preparation, backend identity lookup, project
   ensure, repository ensure, repository polling, scaffold, and Git origin setup.
5. Add focused tests that simulate:
   fetch throwing before response;
   backend `ProblemDetails` with 401/409/422/500;
   local maintainer helper failure;
   repository timeout; and
   fatal output not containing `undefined is not an object`.
6. Verify with the existing CLI lane:
   `mise exec node@24 -- pnpm --dir apps/dreamboard-cli run typecheck` and
   `mise exec node@24 -- pnpm --dir apps/dreamboard-cli run test`.

## Suggested Error Taxonomy

| Category | Detection | Default resolution |
| --- | --- | --- |
| Transport failure | fetch throws or response is missing | Check selected environment/API URL; start local backend or retry remote target. |
| Authentication failure | HTTP 401 or auth problem type | Run `dreamboard auth login` for the selected environment. |
| Authorization failure | HTTP 403 | Sign in with an account that has access to the project/account. |
| Slug/project conflict | HTTP 409 or slug conflict problem type | Choose another slug or use an explicit force/rebind path. |
| Validation failure | HTTP 400/422 | Fix the validation details returned by the backend. |
| Repository provisioning failure | terminal repository state or timeout | Retry after provisioning recovers; avoid creating duplicate projects. |
| Local maintainer setup failure | local snapshot helper spawn/parse failure | Install source-checkout tooling or switch to a published/remote package path. |
| Unexpected CLI bug | uncategorized exception | Show concise failure plus debug instructions; keep stack out of default output. |

## Machine Output

Human output should improve without weakening machine output. For `--json` and
`--json-events`, contextual failures should continue to use
`packages/cli-core` command-result shapes, with the Dreamboard-specific details
mapped into the existing problem object where possible:

1. `code`: stable error code or problem type;
2. `title`: concise failure;
3. `detail`: recovery guidance;
4. `status`: HTTP status when present;
5. optional context fields for step, environment, API base URL, and request ID.

The portable `packages/cli-core` package should not learn about Dreamboard
environments, API URLs, repository provisioning, or auth login wording.

## Discussion Questions

1. Should `project create` record partial creation state when the remote project
   exists but local scaffolding did not finish?
2. Should `--force` be the recovery path for slug conflicts, or should we add a
   more explicit rebind/recreate command?
3. Should local dev default messages mention the exact command that starts the
   local backend, or should they stay generic until that command surface is
   stable?
4. Should debug stack traces be gated by `DREAMBOARD_CLI_DEBUG=1`,
   `--verbose`, or both?
5. Should the local maintainer package snapshot phase be skipped automatically
   for remote environments, or is the current API-base-url driven behavior the
   intended source-checkout path?

## Recommended First Patch

Start with the smallest user-visible improvement:

1. add contextual transport normalization for missing responses;
2. wrap the `project create` backend identity, ensure project, and repository
   phases; and
3. add regression tests for the original raw `response.status` failure.

This should convert the current confusing crash into a useful operator message
without changing backend contracts or the portable CLI core boundary.
