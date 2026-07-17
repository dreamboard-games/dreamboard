import path from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import {
  resolveConfig,
  requireAuth,
  configureClient,
} from "../config/resolve.js";
import { parseNewCommandArgs } from "../flags.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { normalizeSlug } from "../utils/strings.js";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  ensureProjectRepositorySdk,
  ensureProjectSdk,
  loadRemoteProjectIdentity,
  pollProjectRepository,
} from "../services/api/index.js";
import { configureWorkspaceGitOrigin } from "../services/git/workspace-origin.js";
import { materializeWorkspaceProject } from "../services/project/materialize-workspace.js";
import { ProjectCreateOperation } from "../services/project/project-create-operation.js";

const DEFAULT_REPOSITORY_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_REPOSITORY_POLL_INTERVAL_MS = 1_000;

function parsePositiveIntegerFlag(
  value: string | undefined,
  flagName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

export default defineCommand({
  meta: {
    name: "create",
    description: "Create a new project and scaffold a local workspace",
  },
  args: {
    slug: { type: "positional", description: "Game slug", required: true },
    description: {
      type: "string",
      description: "Short description of the game to create",
      required: true,
    },
    "wait-timeout-ms": {
      type: "string",
      description: "Maximum time to wait for Git repository setup",
    },
    "repository-poll-interval-ms": {
      type: "string",
      description: "Polling interval for Git repository setup",
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseNewCommandArgs(args);
    const slugInput = parsedArgs.slug;
    const description = parsedArgs.description.trim();
    const repositoryWaitTimeoutMs = parsePositiveIntegerFlag(
      parsedArgs["wait-timeout-ms"],
      "--wait-timeout-ms",
      DEFAULT_REPOSITORY_WAIT_TIMEOUT_MS,
    );
    const repositoryPollIntervalMs = parsePositiveIntegerFlag(
      parsedArgs["repository-poll-interval-ms"],
      "--repository-poll-interval-ms",
      DEFAULT_REPOSITORY_POLL_INTERVAL_MS,
    );

    const normalizedSlug = normalizeSlug(slugInput);
    if (!normalizedSlug) {
      throw new Error("Slug must contain at least one alphanumeric character.");
    }
    if (normalizedSlug !== slugInput) {
      consola.info(`Normalized slug to '${normalizedSlug}'.`);
    }

    const [globalConfig, storedSession] = await Promise.all([
      loadGlobalConfig(),
      getStoredSession(),
    ]);
    const config = resolveConfig(
      globalConfig,
      parsedArgs,
      undefined,
      storedSession,
    );
    const targetDir = path.resolve(process.cwd(), normalizedSlug);
    const operation = await ProjectCreateOperation.open({
      environment: config.environment,
      apiBaseUrl: config.apiBaseUrl,
      slug: normalizedSlug,
      targetDir,
    });
    requireAuth(config);
    await operation.run("configure_client", () => configureClient(config));
    const identity = await operation.run("resolve_identity", () =>
      loadRemoteProjectIdentity(),
    );

    await operation.markAttempted("remoteProjectState");
    const project = await operation.run("ensure_project", () =>
      ensureProjectSdk({
        projectId: operation.projectId,
        slug: normalizedSlug,
        description,
      }),
    );
    await operation.markConfirmed("remoteProjectState");

    await operation.markAttempted("repositoryState");
    await operation.run("ensure_repository", () =>
      ensureProjectRepositorySdk(operation.projectId),
    );

    consola.start("Setting up Git repository...");
    const repository = await operation.run("wait_for_repository", () =>
      pollProjectRepository({
        projectId: operation.projectId,
        timeoutMs: repositoryWaitTimeoutMs,
        intervalMs: repositoryPollIntervalMs,
      }),
    );
    if (repository.provisioningState !== "READY") {
      throw new Error(
        `Repository setup did not complete for ${operation.projectId}: ${repository.provisioningState}${repository.errorCode ? ` (${repository.errorCode})` : ""}. Retry project creation after fixing the repository provisioning issue.`,
      );
    }
    await operation.markConfirmed("repositoryState");
    consola.success("Git repository ready.");

    const blankManifest: GameTopologyManifest = {
      players: {
        minPlayers: 2,
        maxPlayers: 4,
        optimalPlayers: 4,
      },
      cardSets: [],
      zones: [],
      boardTemplates: [],
      boards: [],
      pieceTypes: [],
      pieceSeeds: [],
      dieTypes: [],
      dieSeeds: [],
      resources: [],
      setupOptions: [],
      setupProfiles: [],
    };

    consola.start("Scaffolding local workspace...");
    await operation.markAttempted("workspaceState");
    await operation.run("materialize_workspace", () =>
      materializeWorkspaceProject({
        targetDir,
        projectId: operation.projectId,
        slug: project.slug,
        deploymentId: identity.deploymentId,
        ownerScopeId: identity.ownerScopeId,
        bindingKey: identity.bindingKey,
        remoteHeadDigest: project.head?.revisionDigest,
        apiBaseUrl: config.apiBaseUrl,
        webBaseUrl: config.webBaseUrl,
        manifest: blankManifest,
        ruleText: "",
      }),
    );
    await operation.markConfirmed("workspaceState");

    await operation.markAttempted("gitState");
    await operation.run("configure_git", () =>
      configureWorkspaceGitOrigin({
        projectRoot: targetDir,
        cloneUrl: repository.cloneUrl,
      }),
    );
    await operation.markConfirmed("gitState");

    consola.success(`Created new project in ${targetDir}`);
    consola.info(
      "Next: edit your files, commit with Git, push to origin, then run 'dreamboard build --commit HEAD'.",
    );
  },
});
