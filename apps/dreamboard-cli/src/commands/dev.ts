import path from "node:path";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { defineCommand } from "citty";
import {
  getApiVersion,
  getSessionSnapshot,
  type CompiledResult,
  type EnsureDevCompileRequest,
  type EnsureDevCompileResponse,
} from "@dreamboard-games/api-client";
import type { GameTopologyManifest as ApiGameTopologyManifest } from "@dreamboard-games/api-client/types.gen";
import {
  materializeSourceChangeOperations,
  mapUpsertBlobContentsByContentHash,
} from "@dreamboard-games/api-client/source-revisions";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { PROJECT_DIR_NAME } from "../constants.js";
import { resolveProjectContext } from "../config/resolve.js";
import { resolveLocalHarnessAccessToken } from "../config/local-harness-auth.js";
import { createUserSessionManager } from "../auth/user-session-manager.js";
import { parseDevCommandArgs, parsePlayerCountFlags } from "../flags.js";
import type { ProjectConfig } from "../types.js";
import { ensureDir, readTextFile, writeJsonFile } from "../utils/fs.js";
import {
  createPersistedDevSession,
  parseDevSeed,
} from "../utils/dev-session.js";
import { extractUserIdFromJwt } from "../utils/jwt.js";
import { resolvePlayerCount } from "../utils/player-count.js";
import { isStaleContractArtifactError } from "../utils/errors.js";
import { openBrowser } from "../auth/auth-server.js";
import { loadProjectDevHost } from "../services/dev-host/loader.js";
import { createCliDevHostPlatform } from "../services/dev-host/platform.js";
import {
  createSessionFromScenario,
  generateReducerNativeArtifacts,
} from "../services/testing/reducer-native-test-harness.js";
import { resolveSetupProfileSelectionForSession } from "../services/workflows/resolve-setup-profile.js";
import {
  collectLocalFiles,
  loadManifest,
  loadRule,
} from "../services/project/local-files.js";
import {
  createProjectSessionSdk,
  ensureProjectDevCompileSdk,
  uploadProjectSourceBlobsSdk,
  waitForCompiledResultJobSdk,
} from "../services/api/index.js";
import { resolveRemoteProject } from "../services/project/remote-project.js";
import { runLocalTypecheck } from "../services/project/local-typecheck.js";
import {
  didLocalMaintainerSnapshotChange,
  ensureLocalMaintainerSnapshot,
  isLocalMaintainerRegistryEnabled,
} from "../services/project/local-maintainer-registry.js";
import { assertReleaseEnvironmentPortableDependencies } from "../services/project/dependency-portability.js";
import {
  getProjectLocalMaintainerRegistry,
  updateProjectLocalMaintainerRegistry,
} from "../services/project/project-state.js";
import { updateProjectState } from "../config/project-config.js";
import { scaffoldStaticWorkspace } from "../services/project/static-scaffold.js";
import { applyWorkspaceCodegen } from "../services/project/workspace-codegen.js";
import { reconcileWorkspaceDependencies } from "../services/project/workspace-dependencies.js";
import { assertReducerContractPreflight } from "../services/project/reducer-contract-preflight.js";
import { assertReducerBundleSmoke } from "../services/project/reducer-bundle-preflight.js";
import { isSourceRevisionPath } from "../services/project/source-revision-paths.js";
import { projectIdFromSessionGameSource } from "../utils/session-game-source.js";
import {
  DEV_STARTUP_DIAGNOSTICS_ENABLED,
  createDevStartupTimingCollector,
  devDiagnosticArgs,
  hasDevStartupTimingArg,
  sanitizeDevStartupMessage,
  writeDevStartupTimingReport,
  type DevStartupPhase,
  type DevStartupTimingCollector,
} from "./dev-startup-timings.js";

async function runLoggedStep<T>(
  message: string,
  task: () => Promise<T>,
  timing?: {
    collector: DevStartupTimingCollector;
    phase: DevStartupPhase;
  },
): Promise<T> {
  consola.start(message);
  return timing ? timing.collector.timed(timing.phase, task) : task();
}

function formatDevCompileJobProgressMessage(job: {
  status: string;
  phase?: string;
  queuePosition?: number;
  message?: string | null;
}): string {
  const phase = job.phase ? ` [${job.phase}]` : "";
  const detail = job.message
    ? ` ${sanitizeDevStartupMessage(job.message)}`
    : "";
  if (job.status === "PENDING") {
    const queue =
      typeof job.queuePosition === "number"
        ? ` (queue ${job.queuePosition + 1})`
        : "";
    return `Dev compile queued${queue}${phase}${detail}`.trim();
  }
  if (job.status === "RUNNING") {
    return `Dev compile running${phase}${detail}`.trim();
  }
  if (job.status === "FAILED") {
    return `Dev compile failed${phase}${detail}`.trim();
  }
  return `Dev compile ${job.status.toLowerCase()}${phase}${detail}`.trim();
}

function formatDevCompileDiagnostics(
  diagnostics: CompiledResult["diagnostics"],
): string | null {
  const lines = diagnostics
    ?.map((diagnostic) => {
      const location =
        diagnostic.type === "file"
          ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
          : diagnostic.category;
      const code = diagnostic.code ? ` ${diagnostic.code}` : "";
      const message = diagnostic.message.trim();
      return `- [${diagnostic.severity}] ${location}${code}: ${message}`;
    })
    .filter((line) => line.trim().length > 0);

  return lines && lines.length > 0 ? lines.join("\n") : null;
}

function assertDevCompiledResultStartable(
  compiledResult: CompiledResult,
): CompiledResult {
  const blockers: string[] = [];
  if (!compiledResult.success) blockers.push("compile did not succeed");
  if (!compiledResult.appStorageKey) blockers.push("missing APP storage key");
  if (!compiledResult.uiStorageKey) blockers.push("missing UI storage key");

  if (blockers.length === 0) {
    return compiledResult;
  }

  const diagnostics = formatDevCompileDiagnostics(compiledResult.diagnostics);
  const details = diagnostics
    ? `Diagnostics:\n${diagnostics}`
    : "No compiler diagnostics were returned.";
  throw new Error(
    [
      `Dev compile ${compiledResult.id} is not startable (${blockers.join(", ")}).`,
      details,
      "Fix the compile diagnostics before starting dreamboard dev.",
    ].join("\n"),
  );
}

function clearPreflightOutput(): void {
  if (!process.stdout.isTTY || process.env.CI) return;
  console.clear();
}

function formatDevReadyOutput(options: {
  url: string;
  networkUrls: string[];
  allowedHosts: string[];
  apiBaseUrl: string;
  sessionStatus: "created" | "reused" | "seeded";
  shortCode: string;
  sessionId: string;
  seed: number | "unknown";
  debug: boolean;
  scenarioId?: string | null;
  materialization?: DevRunSession["materialization"];
  setupProfile?: {
    id: string;
    name?: string | null;
  } | null;
}): string {
  const lines = ["Dreamboard dev", "", `Local:   ${options.url}`];

  for (const networkUrl of options.networkUrls) {
    lines.push(`Network: ${networkUrl}`);
  }

  if (options.networkUrls.length > 0) {
    lines.push("Access:  LAN only; use trusted networks.");
  }

  for (const allowedHost of options.allowedHosts) {
    lines.push(`Allowed: ${allowedHost}`);
  }

  lines.push(
    `Session: ${options.shortCode} (${options.sessionId}, ${options.sessionStatus})`,
    `Seed:    ${options.seed}`,
  );

  if (options.setupProfile) {
    const label = options.setupProfile.name
      ? `${options.setupProfile.name} (${options.setupProfile.id})`
      : options.setupProfile.id;
    lines.push(`Setup:   ${label}`);
  }

  if (options.scenarioId) {
    lines.push(`Scenario: ${options.scenarioId}`);
  }

  if (options.materialization) {
    lines.push(
      `Snapshot: ${options.materialization.totalMs}ms total (${options.materialization.reducerHarnessMs}ms reducer, ${options.materialization.backendHydrateMs}ms backend)`,
    );
  }

  lines.push(
    `Backend: ${options.apiBaseUrl}`,
    "",
    "UI edits hot-reload. Rule, manifest, and app changes need restart.",
    `Debug logs: ${options.debug ? "on" : "off (--debug)"}`,
    "",
  );

  return lines.join("\n");
}

function parseDevHost(
  value: string | boolean | undefined,
): string | boolean | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : true;
}

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((host) => normalizeAllowedHost(host))
    .filter((host): host is string => Boolean(host));
}

function normalizeAllowedHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.includes("://")) {
    return new URL(trimmed).hostname;
  }

  return trimmed.split("/")[0]?.replace(/:\d+$/, "") || null;
}

function warnForExplicitDevPort(port: number): void {
  consola.warn(
    `Using --port ${port}. If gameplay authority rejects the browser origin, add http://localhost:${port} and http://127.0.0.1:${port} to GAMEPLAY_AUTHORITY_ALLOWED_ORIGINS for this environment.`,
  );
}

function parsePreferredDevPort(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const preferredPort = Number.parseInt(value, 10);
  if (!Number.isFinite(preferredPort) || preferredPort <= 0) {
    throw new Error("Invalid --port value. Expected a positive integer.");
  }
  warnForExplicitDevPort(preferredPort);
  return preferredPort;
}

type DevProgressHost = {
  url: string;
  close(): Promise<void>;
};

async function startDevProgressHost(options: {
  port: number | undefined;
  host: string | boolean | undefined;
}): Promise<DevProgressHost> {
  const requestedPort = options.port ?? 5352;
  const bindHost =
    typeof options.host === "string"
      ? options.host
      : options.host === true
        ? "0.0.0.0"
        : "127.0.0.1";
  try {
    return await listenDevProgressHost(requestedPort, bindHost);
  } catch (error) {
    if (options.port || !isAddressInUseError(error)) {
      throw error;
    }
    return listenDevProgressHost(0, bindHost);
  }
}

function listenDevProgressHost(
  port: number,
  bindHost: string,
): Promise<DevProgressHost> {
  const server = createServer((request, response) => {
    const pathname = request.url ? new URL(request.url, "http://localhost").pathname : "/";
    if (pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dreamboard dev</title>
    <style>
      body {
        align-items: center;
        background: #f8f5ef;
        color: #28231d;
        display: flex;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
      }
      main {
        max-width: 34rem;
        padding: 2rem;
      }
      h1 {
        font-size: 1.5rem;
        font-weight: 650;
        letter-spacing: 0;
        margin: 0 0 0.75rem;
      }
      p {
        line-height: 1.6;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Preparing Dreamboard dev</h1>
      <p>The local host is open while Dreamboard checks the workspace, reuses any matching compile, and creates a playable session.</p>
    </main>
  </body>
</html>`);
  });

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(port, bindHost, () => {
      server.off("error", fail);
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://localhost:${actualPort}/`,
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAddressInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

function isDevUsageRequest(): boolean {
  return process.argv.some((arg) => arg === "--help" || arg === "-h");
}

type DevResumeResult = {
  session: DevRunSession | null;
  reason: string | null;
  resetNotice?: string;
};

const STALE_DEV_SESSION_RESET_NOTICE =
  "Resetting disposable dev session because the previous session was created for a stale contract artifact.";

type DevRunSession = {
  sessionId: string;
  shortCode: string;
  projectId: string;
  seed?: number;
  setupProfileId?: string;
  materialization?: {
    mode: "snapshot";
    totalMs: number;
    reducerHarnessMs: number;
    backendHydrateMs: number;
  };
};

export default defineCommand({
  meta: {
    name: "dev",
    description:
      "Start a local iframe host for the current project while gameplay stays on the backend",
  },
  args: () => ({
    seed: {
      type: "string",
      description: "Deterministic RNG seed for new sessions (defaults to 1337)",
    },
    "setup-profile": {
      type: "string",
      description:
        "Named setup profile to use when the manifest defines curated setup presets",
    },
    players: {
      type: "string",
      description: "Number of seats to create",
    },
    "player-count": {
      type: "string",
      description: "Number of seats to create (alias)",
    },
    debug: {
      type: "boolean",
      description:
        "Print browser/runtime logs and full SSE payloads in the terminal",
      default: false,
    },
    resume: {
      type: "string",
      description: "Resume a specific existing backend session by session id",
    },
    "from-scenario": {
      type: "string",
      description:
        "Create a backend session by materializing a typed test scenario snapshot",
    },
    "new-session": {
      type: "boolean",
      description:
        "Deprecated alias for the default behavior of creating a fresh session",
      default: false,
    },
    open: {
      type: "boolean",
      description: "Open the local dev host in the browser",
      default: false,
    },
    port: {
      type: "string",
      description: "Preferred local Vite port (defaults to 5352)",
    },
    host: {
      type: "string",
      description:
        "Expose the local dev host on the network. Pass without a value to bind all interfaces, or provide an address.",
      valueHint: "address",
    },
    "allowed-host": {
      type: "string",
      description:
        "Additional Host header to allow, for example a Cloudflare Tunnel hostname.",
      valueHint: "hostname",
    },
    ...(isDevUsageRequest() ? {} : devDiagnosticArgs()),
    ...CONFIG_FLAG_ARGS,
  }),
  async run({ args, rawArgs }) {
    if (!DEV_STARTUP_DIAGNOSTICS_ENABLED && hasDevStartupTimingArg(rawArgs)) {
      throw new Error("Unknown option: --timings-json");
    }
    const parsedArgs = parseDevCommandArgs(args);
    const startupTimings = createDevStartupTimingCollector();
    let timingsWritten = false;
    let progressHost: DevProgressHost | null = null;
    const writeTimings = async (status: "ready" | "failed") => {
      if (timingsWritten) return;
      timingsWritten = true;
      await writeDevStartupTimingReport(
        parsedArgs["timings-json"],
        startupTimings.report(status),
      );
    };

    try {
      const { projectRoot, projectConfig, config } = await runLoggedStep(
        "Resolving project context...",
        () => resolveProjectContext(parsedArgs),
        {
          collector: startupTimings,
          phase: "resolveProjectContext",
        },
      );
      const remoteProject = await runLoggedStep(
        "Resolving remote project...",
        () =>
          resolveRemoteProject({
            projectRoot,
            projectConfig,
            config,
          }),
        {
          collector: startupTimings,
          phase: "resolveRemoteProject",
        },
      );
      const effectiveProjectConfig = remoteProject.projectConfig;
      const effectiveAuthToken =
        resolveLocalHarnessAccessToken(config) ??
        (await createUserSessionManager(config).resolveApiToken())?.token ??
        config.authToken;
      const authenticatedConfig = {
        ...config,
        authToken: effectiveAuthToken,
      };
      const preferredPort = parsePreferredDevPort(parsedArgs.port);
      const devHostBinding = parseDevHost(parsedArgs.host);
      const allowedHosts = parseAllowedHosts(parsedArgs["allowed-host"]);
      progressHost = await startupTimings.timed("startProgressHost", () =>
        startDevProgressHost({
          port: preferredPort,
          host: devHostBinding,
        }),
      );
      consola.info(`Preparing dev host: ${progressHost.url}`);

      const devCompile = await ensureDevCompiledResult({
        projectRoot,
        projectConfig: effectiveProjectConfig,
        config: authenticatedConfig,
        env: parsedArgs.env ?? "local",
        debug: parsedArgs.debug,
        startupTimings,
      });

      const devDir = path.join(projectRoot, PROJECT_DIR_NAME, "dev");
      await ensureDir(devDir);
      const sessionFilePath = path.join(devDir, "session.json");

      const requestedResumeSessionId = parsedArgs.resume?.trim() || null;
      const requestedScenarioId = parsedArgs["from-scenario"]?.trim() || null;
      if (requestedResumeSessionId && parsedArgs["new-session"]) {
        throw new Error("Cannot combine --resume with --new-session.");
      }
      if (requestedResumeSessionId && requestedScenarioId) {
        throw new Error("Cannot combine --resume with --from-scenario.");
      }
      if (
        requestedScenarioId &&
        (parsedArgs.seed ||
          parsedArgs["setup-profile"] ||
          parsedArgs.players ||
          parsedArgs["player-count"])
      ) {
        throw new Error(
          "--from-scenario materializes the scenario's authored seed, setup profile, and player count. Remove --seed, --setup-profile, and player-count overrides.",
        );
      }

      const requestedSeed = requestedScenarioId
        ? null
        : parseDevSeed(parsedArgs.seed);
      const selectedSetupProfile = requestedScenarioId
        ? null
        : await resolveSetupProfileSelectionForSession({
            projectRoot,
            requestedSetupProfileId: parsedArgs["setup-profile"],
          });
      let selectedSetupProfileId = selectedSetupProfile?.id ?? null;
      let resolvedPlayerCount = requestedScenarioId
        ? 0
        : await resolvePlayerCount(
            projectRoot,
            parsePlayerCountFlags(parsedArgs),
          );
      const resumeResult = requestedResumeSessionId
        ? await tryResumeSession(
            { sessionId: requestedResumeSessionId },
            effectiveProjectConfig.projectId,
            selectedSetupProfileId,
          )
        : { session: null, reason: null };

      if (requestedResumeSessionId && resumeResult.resetNotice) {
        consola.info(resumeResult.resetNotice);
      } else if (requestedResumeSessionId && resumeResult.reason) {
        consola.warn(
          `Ignoring requested dev session ${requestedResumeSessionId}: ${resumeResult.reason}`,
        );
      }

      let runSession = resumeResult.session;
      let scenarioSeededSession = false;
      const resumedExistingSession = Boolean(
        requestedResumeSessionId &&
        runSession &&
        runSession.sessionId === requestedResumeSessionId,
      );
      if (resumedExistingSession) {
        startupTimings.record("createSession", 0, "reused");
      }

      if (requestedScenarioId) {
        const seededScenario = await startupTimings.timed(
          "createSession",
          async () => {
            await generateReducerNativeArtifacts({
              projectRoot,
              compiledResultId: devCompile.id,
              projectId: effectiveProjectConfig.projectId,
              debug: parsedArgs.debug,
            });
            return createSessionFromScenario({
              projectRoot,
              scenarioId: requestedScenarioId,
              compiledResultId: devCompile.id,
              projectId: effectiveProjectConfig.projectId,
              debug: parsedArgs.debug,
              trustGeneratedFingerprint: true,
            });
          },
        );
        scenarioSeededSession = true;
        selectedSetupProfileId = seededScenario.setupProfileId;
        resolvedPlayerCount = seededScenario.playerCount;
        runSession = {
          sessionId: seededScenario.sessionId,
          shortCode: seededScenario.shortCode,
          projectId: seededScenario.projectId,
          seed: seededScenario.seed,
          setupProfileId: seededScenario.setupProfileId ?? undefined,
          materialization: seededScenario.materialization,
        };
      } else if (!runSession) {
        runSession = await startupTimings.timed("createSession", () =>
          createDevSession({
            projectRoot,
            projectConfig: effectiveProjectConfig,
            playerCount: resolvedPlayerCount,
            seed: requestedSeed ?? 1337,
            compiledResult: devCompile,
            setupProfileId: selectedSetupProfileId,
          }),
        );
      }
      if (!runSession) {
        throw new Error("Unable to create or resume a dev session.");
      }
      const activeRunSession = runSession;

      await writeJsonFile(
        sessionFilePath,
        createPersistedDevSession({ sessionId: activeRunSession.sessionId }),
      );

      await progressHost.close();
      progressHost = null;

      const devServer = await startupTimings.timed(
        "activateDevHost",
        async () => {
          const loadedDevHost = await loadProjectDevHost(projectRoot);
          return loadedDevHost.module.start(
            {
              projectRoot,
              sessionFilePath,
              apiBaseUrl: config.apiBaseUrl,
              port: preferredPort,
              host: devHostBinding,
              allowedHosts,
              runtimeConfig: {
                apiBaseUrl: config.apiBaseUrl,
                userId: extractUserIdFromJwt(effectiveAuthToken ?? null),
                projectId: effectiveProjectConfig.projectId,
                compiledResultId: devCompile.id,
                setupProfileId: activeRunSession.setupProfileId ?? null,
                playerCount: resolvedPlayerCount,
                debug: parsedArgs.debug,
                slug: effectiveProjectConfig.slug,
                autoStartGame:
                  !resumedExistingSession && !scenarioSeededSession,
                initialSession: {
                  sessionId: activeRunSession.sessionId,
                  shortCode: activeRunSession.shortCode,
                  projectId: effectiveProjectConfig.projectId,
                  seed: activeRunSession.seed ?? null,
                },
              },
            },
            createCliDevHostPlatform(authenticatedConfig),
          );
        },
      );

      clearPreflightOutput();
      console.log(
        formatDevReadyOutput({
          url: devServer.url,
          networkUrls: devServer.networkUrls,
          allowedHosts,
          apiBaseUrl: config.apiBaseUrl,
          sessionStatus: scenarioSeededSession
            ? "seeded"
            : resumedExistingSession
              ? "reused"
              : "created",
          shortCode: activeRunSession.shortCode,
          sessionId: activeRunSession.sessionId,
          seed: activeRunSession.seed ?? "unknown",
          debug: parsedArgs.debug,
          scenarioId: scenarioSeededSession ? requestedScenarioId : null,
          materialization: activeRunSession.materialization,
          setupProfile: selectedSetupProfileId
            ? {
                id: selectedSetupProfileId,
                name: selectedSetupProfile?.name,
              }
            : null,
        }),
      );

      if (parsedArgs.open) {
        openBrowser(devServer.url);
      }

      await writeTimings("ready");
      await waitForTermination(async () => {
        await devServer.close();
      });
    } catch (error) {
      if (progressHost) {
        await progressHost.close().catch(() => undefined);
        progressHost = null;
      }
      await writeTimings("failed");
      throw error;
    }
  },
});

async function tryResumeSession(
  requested: {
    sessionId: string;
  },
  currentGameId: string,
  setupProfileId: string | null,
): Promise<DevResumeResult> {
  const { data: snapshot, error } = await getSessionSnapshot({
    path: { sessionId: requested.sessionId },
  }).catch((error: unknown) => {
    if (isStaleContractArtifactError(error)) {
      return {
        data: null,
        error,
      };
    }
    throw error;
  });
  if (isStaleContractArtifactError(error)) {
    return {
      session: null,
      reason: null,
      resetNotice: STALE_DEV_SESSION_RESET_NOTICE,
    };
  }
  if (error || !snapshot) {
    return {
      session: null,
      reason: "backend could not confirm that the session is still active",
    };
  }
  const context = snapshot.context;
  if (projectIdFromSessionGameSource(context.gameSource) !== currentGameId) {
    return {
      session: null,
      reason: "session belongs to a different project",
    };
  }
  if ((context.setupProfileId ?? null) !== setupProfileId) {
    return {
      session: null,
      reason: `setup profile changed from ${context.setupProfileId ?? "none"} to ${setupProfileId ?? "none"}`,
    };
  }
  if (context.status === "ended" || context.phase === "ended") {
    return {
      session: null,
      reason: "session has already ended",
    };
  }

  return {
    session: {
      sessionId: context.sessionId,
      shortCode: context.shortCode,
      projectId: projectIdFromSessionGameSource(context.gameSource),
      setupProfileId: context.setupProfileId ?? undefined,
    },
    reason: null,
  };
}

async function ensureDevCompiledResult(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  config: { apiBaseUrl: string; authToken?: string };
  env: string;
  debug: boolean;
  startupTimings: DevStartupTimingCollector;
}): Promise<CompiledResult> {
  await assertReleaseEnvironmentPortableDependencies({
    projectRoot: options.projectRoot,
    projectConfig: options.projectConfig,
    environment: options.env,
  });
  const localMaintainerEnabled = isLocalMaintainerRegistryEnabled(
    options.config.apiBaseUrl,
  );
  const existingLocalMaintainerRegistry = getProjectLocalMaintainerRegistry(
    options.projectConfig,
  );
  if (!localMaintainerEnabled && existingLocalMaintainerRegistry) {
    await updateProjectState(
      options.projectRoot,
      updateProjectLocalMaintainerRegistry(options.projectConfig, undefined),
    );
  }
  const refreshedLocalMaintainerRegistry = localMaintainerEnabled
    ? await runLoggedStep("Checking local SDK snapshot...", () =>
        ensureLocalMaintainerSnapshot(options.config.apiBaseUrl),
      )
    : await ensureLocalMaintainerSnapshot(options.config.apiBaseUrl);
  const localMaintainerRegistry =
    refreshedLocalMaintainerRegistry ??
    (localMaintainerEnabled ? (existingLocalMaintainerRegistry ?? null) : null);
  if (refreshedLocalMaintainerRegistry) {
    if (
      didLocalMaintainerSnapshotChange(
        existingLocalMaintainerRegistry,
        refreshedLocalMaintainerRegistry,
      )
    ) {
      await updateProjectState(
        options.projectRoot,
        updateProjectLocalMaintainerRegistry(
          options.projectConfig,
          refreshedLocalMaintainerRegistry,
        ),
      );
      consola.info("Local SDK snapshot refreshed.");
    } else {
      consola.info("Using existing local SDK snapshot.");
    }
  } else if (localMaintainerRegistry) {
    consola.info("Using workspace-pinned local SDK snapshot.");
  }

  await runLoggedStep(
    "Refreshing static scaffold...",
    () =>
      scaffoldStaticWorkspace(options.projectRoot, "update", {
        localMaintainerRegistry,
      }),
    {
      collector: options.startupTimings,
      phase: "refreshScaffold",
    },
  );
  const manifest = await loadManifest(options.projectRoot);
  await runLoggedStep(
    "Applying workspace codegen...",
    () =>
      applyWorkspaceCodegen({
        projectRoot: options.projectRoot,
        manifest: manifest as ApiGameTopologyManifest,
      }),
    {
      collector: options.startupTimings,
      phase: "workspaceCodegen",
    },
  );
  const dependencyState = await runLoggedStep(
    "Reconciling workspace dependencies...",
    () => reconcileWorkspaceDependencies(options.projectRoot),
    {
      collector: options.startupTimings,
      phase: "dependencyReconcile",
    },
  );
  if (
    dependencyState.packageManagerNormalized ||
    dependencyState.lockfileGenerated ||
    dependencyState.installed
  ) {
    consola.info("Workspace dependencies reconciled.");
  } else {
    consola.info("Workspace dependencies already up to date.");
  }
  await runLoggedStep(
    "Validating reducer contract...",
    () => assertReducerContractPreflight(options.projectRoot),
    {
      collector: options.startupTimings,
      phase: "reducerContract",
    },
  );
  const typecheckResult = await runLoggedStep(
    "Running local typecheck...",
    () => runLocalTypecheck(options.projectRoot),
    {
      collector: options.startupTimings,
      phase: "localTypecheck",
    },
  );
  if (!typecheckResult.skipped && !typecheckResult.success) {
    if (typecheckResult.output) consola.error(typecheckResult.output);
    throw new Error(
      "Local typecheck failed. Fix the diagnostics before starting dev.",
    );
  }
  if (typecheckResult.output && typecheckResult.skipped)
    consola.warn(typecheckResult.output);
  await runLoggedStep(
    "Smoke-testing reducer bundle...",
    () =>
      assertReducerBundleSmoke({
        projectRoot: options.projectRoot,
        manifest: manifest as ApiGameTopologyManifest,
      }),
    {
      collector: options.startupTimings,
      phase: "reducerSmoke",
    },
  );
  consola.success("Reducer bundle smoke test passed.");
  consola.start("Ensuring dev compile...");

  const [localFiles, ruleText, backendVersion, workspacePackageJson] =
    await options.startupTimings.timed("computeFingerprint", async () => {
      const [files, rule, version, packageJson] = await Promise.all([
        collectLocalFiles(options.projectRoot),
        loadRule(options.projectRoot),
        resolveBackendVersionMetadata(),
        readWorkspacePackageJson(options.projectRoot),
      ]);
      return [files, rule, version, packageJson] as const;
    });
  const sourceRevisionFiles = Object.fromEntries(
    Object.entries(localFiles).filter(([filePath]) =>
      isSourceRevisionPath(filePath),
    ),
  );
  const sourceChanges = Object.entries(sourceRevisionFiles).map(
    ([filePath, content]) => ({
      kind: "upsert" as const,
      path: filePath,
      content,
    }),
  );
  const { changes } = await materializeSourceChangeOperations(sourceChanges);
  const uploadBlobs = mapUpsertBlobContentsByContentHash(
    sourceChanges,
    changes,
  );
  const devFingerprint = computeDevFingerprint({
    env: options.env,
    files: localFiles,
    manifest,
    ruleText,
    localMaintainerRegistry,
    backendVersion,
    workspacePackageJson,
  });

  const first = await options.startupTimings.timed("lookupCompile", () =>
    postEnsureDevCompile({
      config: options.config,
      projectId: options.projectConfig.projectId,
      body: {
        devFingerprint,
        env: options.env,
        sourceRevision: { mode: "replace", changes: [] },
        ruleText,
        manifest: manifest as ApiGameTopologyManifest,
      },
    }),
  );
  if (first.reused && first.compiledResult) {
    options.startupTimings.record("uploadSource", 0, "skipped");
    options.startupTimings.record("waitForCompile", 0, "reused");
    const compiledResult = assertDevCompiledResultStartable(
      first.compiledResult,
    );
    consola.success(`Reusing dev compile ${compiledResult.id}.`);
    return compiledResult;
  }

  await options.startupTimings.timed("uploadSource", () =>
    uploadProjectSourceBlobsSdk(
      options.projectConfig.projectId,
      Array.from(uploadBlobs.values()),
    ),
  );
  const queued = await postEnsureDevCompile({
    config: options.config,
    projectId: options.projectConfig.projectId,
    body: {
      devFingerprint,
      env: options.env,
      sourceRevision: { mode: "replace", changes },
      ruleText,
      manifest: manifest as ApiGameTopologyManifest,
    },
  });
  if (queued.reused && queued.compiledResult) {
    options.startupTimings.record("waitForCompile", 0, "reused");
    return assertDevCompiledResultStartable(queued.compiledResult);
  }
  const jobId = queued.jobId;
  if (!jobId) throw new Error("Backend did not return a dev compile job id.");

  const { compiledResult } = await options.startupTimings.timed(
    "waitForCompile",
    () =>
      waitForCompiledResultJobSdk({
        projectId: options.projectConfig.projectId,
        jobId,
        onProgress: (job) => {
          const message = sanitizeDevStartupMessage(
            formatDevCompileJobProgressMessage(job),
          );
          if (options.debug) {
            consola.info(message);
          } else {
            consola.start(message);
          }
        },
      }),
  );
  return assertDevCompiledResultStartable(compiledResult);
}

async function resolveBackendVersionMetadata(): Promise<unknown> {
  const { data, error } = await getApiVersion();
  return error ? null : (data ?? null);
}

async function readWorkspacePackageJson(projectRoot: string): Promise<unknown> {
  try {
    const raw = await readTextFile(path.join(projectRoot, "package.json"));
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return {
      dependencies: Object.fromEntries(
        Object.entries(parsed.dependencies ?? {}).filter(([name]) =>
          isDreamboardPublicPackage(name),
        ),
      ),
      devDependencies: Object.fromEntries(
        Object.entries(parsed.devDependencies ?? {}).filter(([name]) =>
          isDreamboardPublicPackage(name),
        ),
      ),
    };
  } catch {
    return null;
  }
}

function isDreamboardPublicPackage(packageName: string): boolean {
  return (
    packageName === "dreamboard" || packageName.startsWith("@dreamboard-games/")
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function computeDevFingerprint(input: {
  env: string;
  files: Record<string, string>;
  manifest: unknown;
  ruleText: string;
  localMaintainerRegistry: unknown;
  backendVersion: unknown;
  workspacePackageJson: unknown;
}): string {
  const hash = createHash("sha256");
  hash.update(
    stableJson({
      env: input.env,
      manifest: input.manifest,
      ruleText: input.ruleText,
      localMaintainerRegistry: input.localMaintainerRegistry,
      backendVersion: input.backendVersion,
      workspacePackageJson: input.workspacePackageJson,
    }),
  );
  for (const [filePath, content] of Object.entries(input.files).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    hash.update(filePath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function postEnsureDevCompile(options: {
  config: { apiBaseUrl: string; authToken?: string };
  projectId: string;
  body: EnsureDevCompileRequest;
}): Promise<EnsureDevCompileResponse> {
  void options.config;
  return ensureProjectDevCompileSdk({
    projectId: options.projectId,
    request: options.body,
  });
}

async function createDevSession(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  playerCount: number;
  seed: number;
  compiledResult: CompiledResult;
  setupProfileId: string | null;
}): Promise<DevRunSession> {
  const session = await createProjectSessionSdk({
    projectId: options.projectConfig.projectId,
    request: {
      compiledResultId: options.compiledResult.id,
      seed: options.seed,
      playerCount: options.playerCount,
      autoAssignSeats: true,
      setupProfileId: options.setupProfileId ?? undefined,
    },
  });

  return {
    sessionId: session.sessionId,
    shortCode: session.shortCode,
    projectId: projectIdFromSessionGameSource(session.gameSource),
    seed: options.seed,
    setupProfileId: options.setupProfileId ?? undefined,
  };
}

type TerminationOptions = {
  exitAfterShutdown?: boolean;
  exitProcess?: (code: number) => void;
};

export async function waitForTermination(
  close: () => Promise<void>,
  options: TerminationOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false;
    const exitAfterShutdown = options.exitAfterShutdown ?? true;
    const exitProcess = options.exitProcess ?? ((code) => process.exit(code));

    const cleanupListeners = () => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
    };

    const shutdown = (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      cleanupListeners();
      void close()
        .then(() => {
          consola.info(`Stopped local dev host (${signal}).`);
          resolve();
          if (exitAfterShutdown) {
            exitProcess(0);
          }
        })
        .catch(reject);
    };

    const handleSigint = () => shutdown("SIGINT");
    const handleSigterm = () => shutdown("SIGTERM");

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);
  });
}
