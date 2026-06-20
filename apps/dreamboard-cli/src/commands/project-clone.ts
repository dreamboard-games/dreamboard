import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import { SystemGit } from "@dreamboard-games/cli-core";
import {
  resolveConfig,
  requireAuth,
  configureClient,
} from "../config/resolve.js";
import { parseCloneCommandArgs } from "../flags.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { normalizeSlug } from "../utils/strings.js";
import { exists } from "../utils/fs.js";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  ensureProjectRepositorySdk,
  getProjectBySlugSdk,
  loadRemoteProjectIdentity,
  pollProjectRepository,
} from "../services/api/index.js";
import {
  loadProjectConfig,
  updateProjectEnvironmentState,
} from "../config/project-config.js";
import { cloneDreamboardGitRepository } from "../services/git/workspace-origin.js";
import { installFrozenWorkspaceDependencies } from "../services/project/workspace-dependencies.js";
import { loadManifest, writeSnapshot } from "../services/project/local-files.js";

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

function normalizeProjectLookup(input: string): {
  lookupSlug: string;
  targetSlug: string;
} {
  const trimmed = input.trim();
  const slugSegment = trimmed.includes("/")
    ? trimmed.split("/").filter(Boolean).at(-1) ?? trimmed
    : trimmed;
  const lookupSlug = normalizeSlug(slugSegment);
  return {
    lookupSlug,
    targetSlug: lookupSlug,
  };
}

export default defineCommand({
  meta: { name: "clone", description: "Clone an existing project repository" },
  args: {
    slug: { type: "positional", description: "Game slug", required: true },
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
    const parsedArgs = parseCloneCommandArgs(args);
    const slugInput = parsedArgs.slug;
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

    const { lookupSlug, targetSlug } = normalizeProjectLookup(slugInput);
    if (!lookupSlug) {
      throw new Error("Slug must contain at least one alphanumeric character.");
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
    requireAuth(config);
    await configureClient(config);
    const identity = await loadRemoteProjectIdentity();

    const targetDir = path.resolve(process.cwd(), targetSlug);
    if (await exists(targetDir)) {
      throw new Error(`Target directory already exists: ${targetDir}`);
    }

    const project = await getProjectBySlugSdk(lookupSlug);
    await ensureProjectRepositorySdk(project.projectId);
    consola.start("Resolving Git repository...");
    const repository = await pollProjectRepository({
      projectId: project.projectId,
      timeoutMs: repositoryWaitTimeoutMs,
      intervalMs: repositoryPollIntervalMs,
    });
    if (repository.provisioningState !== "READY") {
      throw new Error(
        `Repository setup did not complete for ${project.projectId}: ${repository.provisioningState}${repository.errorCode ? ` (${repository.errorCode})` : ""}. Retry project clone after fixing the repository provisioning issue.`,
      );
    }

    if (!repository.headCommit) {
      const error = new Error(
        `PROJECT_UNINITIALIZED: Project '${lookupSlug}' has no pushed Git commits to clone. Create and push the initial native Git commit first.`,
      );
      error.name = "PROJECT_UNINITIALIZED";
      throw error;
    }

    const parentDir = path.dirname(targetDir);
    const tempDir = await mkdtemp(
      path.join(parentDir, `.${path.basename(targetDir)}.dreamboard-clone-`),
    );
    let renamed = false;
    try {
      consola.start("Cloning project repository...");
      await cloneDreamboardGitRepository({
        cloneUrl: repository.cloneUrl,
        destination: tempDir,
      });

      const git = new SystemGit();
      const clonedHeadCommit = await git.resolveCommit(tempDir, "HEAD");
      if (clonedHeadCommit !== repository.headCommit) {
        throw new Error(
          `Cloned repository HEAD mismatch: expected ${repository.headCommit}, found ${clonedHeadCommit}. Retry project clone after the repository binding settles.`,
        );
      }

      const clonedProjectConfig = await loadProjectConfig(tempDir);
      if (clonedProjectConfig.projectId !== project.projectId) {
        throw new Error(
          `Cloned repository projectId mismatch: expected ${project.projectId}, found ${clonedProjectConfig.projectId}.`,
        );
      }

      await updateProjectEnvironmentState(tempDir, {
        ...clonedProjectConfig,
        gameId: project.projectId,
        deploymentId: identity.deploymentId,
        ownerScopeId: identity.ownerScopeId,
        bindingKey: identity.bindingKey,
        remoteHeadDigest: project.head?.revisionDigest,
        apiBaseUrl: config.apiBaseUrl,
        webBaseUrl: config.webBaseUrl,
      });

      await installFrozenWorkspaceDependencies(tempDir);
      await loadManifest(tempDir);
      await writeSnapshot(tempDir);
      const trackedChanges = await git.statusPorcelain(tempDir);
      if (trackedChanges) {
        throw new Error(
          `Project clone prepared tracked file changes before handoff:\n${trackedChanges}\nRefusing to publish a mutated checkout.`,
        );
      }

      await rename(tempDir, targetDir);
      renamed = true;
    } finally {
      if (!renamed) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    consola.success(`Cloned ${lookupSlug} into ${targetDir}`);
  },
});
