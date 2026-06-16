import { defineCommand } from "citty";
import consola from "consola";
import {
  mapUpsertBlobContentsByContentHash,
  materializeSourceChangeOperations,
  type SourceContentChangeOperation,
} from "@dreamboard-games/api-client/source-revisions";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext } from "../config/resolve.js";
import { updateProjectState } from "../config/project-config.js";
import { parseSyncCommandArgs } from "../flags.js";
import {
  collectLocalFiles,
  computeManifestHash,
  getLocalDiff,
  loadManifest,
  loadRule,
  writeSnapshot,
} from "../services/project/local-files.js";
import {
  isSourceRevisionPath,
  shouldAlwaysUpsertSourcePath,
} from "../services/project/source-revision-paths.js";
import {
  assertCliStaticScaffoldComplete,
  scaffoldStaticWorkspace,
} from "../services/project/static-scaffold.js";
import {
  createGameRevisionSdk,
  uploadProjectSourceBlobsSdk,
} from "../services/api/index.js";
import {
  getProjectAuthoringState,
  getProjectLocalMaintainerRegistry,
  getProjectPendingAuthoringSync,
  updateProjectAuthoringState,
  updateProjectLocalMaintainerRegistry,
} from "../services/project/project-state.js";
import type { ProjectConfig } from "../types.js";
import { applyWorkspaceCodegen } from "../services/project/workspace-codegen.js";
import {
  didLocalMaintainerSnapshotChange,
  ensureLocalMaintainerSnapshot,
  isLocalMaintainerRegistryEnabled,
} from "../services/project/local-maintainer-registry.js";
import { reconcileWorkspaceDependencies } from "../services/project/workspace-dependencies.js";
import { assertReducerContractPreflight } from "../services/project/reducer-contract-preflight.js";
import { assertReducerBundleSmoke } from "../services/project/reducer-bundle-preflight.js";
import { runLocalTypecheck } from "../services/project/local-typecheck.js";
import { resolveRemoteProject } from "../services/project/remote-project.js";
import { assertReleaseEnvironmentPortableDependencies } from "../services/project/dependency-portability.js";

async function runLoggedStep<T>(
  message: string,
  task: () => Promise<T>,
): Promise<T> {
  consola.start(message);
  return task();
}

async function persistProjectConfig(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
}): Promise<ProjectConfig> {
  await updateProjectState(options.projectRoot, options.projectConfig);
  return options.projectConfig;
}

async function finalizeLocalSync(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
}): Promise<ProjectConfig> {
  const { projectRoot, projectConfig } = options;
  await scaffoldStaticWorkspace(projectRoot, "update", {
    localMaintainerRegistry: getProjectLocalMaintainerRegistry(projectConfig),
  });
  await applyWorkspaceCodegen({
    projectRoot,
    manifest: await loadManifest(projectRoot),
  });

  const finalizedProjectConfig = await persistProjectConfig({
    projectRoot,
    projectConfig,
  });
  await writeSnapshot(projectRoot);
  return finalizedProjectConfig;
}

function buildSourceSnapshotChanges(
  localFiles: Record<string, string>,
): SourceContentChangeOperation[] {
  return Object.entries(localFiles)
    .filter(
      ([filePath]) =>
        isSourceRevisionPath(filePath) ||
        shouldAlwaysUpsertSourcePath(filePath),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({
      kind: "upsert",
      path,
      content,
    }));
}

export default defineCommand({
  meta: {
    name: "sync",
    description:
      "Upload authored changes and advance the remote authoring head",
  },
  args: {
    force: {
      type: "boolean",
      description:
        "Replace the full authored source tree, manifest, and rules, overwriting the remote head with the local copy even when the remote has moved",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Reserved for non-interactive scaffold flows",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseSyncCommandArgs(args);
    const { projectRoot, projectConfig, config } =
      await resolveProjectContext(parsedArgs);
    let nextProjectConfig = projectConfig;
    await assertReleaseEnvironmentPortableDependencies({
      projectRoot,
      projectConfig: nextProjectConfig,
      environment: config.environment,
    });
    const localMaintainerEnabled = isLocalMaintainerRegistryEnabled(
      config.apiBaseUrl,
    );
    const existingLocalMaintainerRegistry =
      getProjectLocalMaintainerRegistry(projectConfig);
    const refreshedLocalMaintainerRegistry = localMaintainerEnabled
      ? await runLoggedStep("Checking local SDK snapshot...", () =>
          ensureLocalMaintainerSnapshot(config.apiBaseUrl),
        )
      : await ensureLocalMaintainerSnapshot(config.apiBaseUrl);
    const localMaintainerRegistry =
      refreshedLocalMaintainerRegistry ??
      (localMaintainerEnabled
        ? (existingLocalMaintainerRegistry ?? null)
        : null);
    const localMaintainerSnapshotChanged = didLocalMaintainerSnapshotChange(
      existingLocalMaintainerRegistry,
      refreshedLocalMaintainerRegistry,
    );
    if (refreshedLocalMaintainerRegistry) {
      nextProjectConfig = updateProjectLocalMaintainerRegistry(
        nextProjectConfig,
        refreshedLocalMaintainerRegistry,
      );
      consola.info(
        localMaintainerSnapshotChanged
          ? "Local SDK snapshot refreshed."
          : "Using existing local SDK snapshot.",
      );
    } else if (localMaintainerRegistry) {
      consola.info("Using workspace-pinned local SDK snapshot.");
    }

    await runLoggedStep("Refreshing static scaffold...", () =>
      scaffoldStaticWorkspace(projectRoot, "update", {
        localMaintainerRegistry,
      }),
    );
    const localManifest = await loadManifest(projectRoot);
    await runLoggedStep("Applying workspace codegen...", async () =>
      applyWorkspaceCodegen({
        projectRoot,
        manifest: localManifest,
      }),
    );
    const dependencyState = await runLoggedStep(
      "Reconciling workspace dependencies...",
      () => reconcileWorkspaceDependencies(projectRoot),
    );
    if (
      dependencyState.packageManagerNormalized ||
      dependencyState.lockfileGenerated ||
      dependencyState.installed ||
      localMaintainerSnapshotChanged
    ) {
      consola.info("Workspace dependencies reconciled.");
    } else {
      consola.info("Workspace dependencies already up to date.");
    }
    await runLoggedStep("Validating reducer contract...", () =>
      assertReducerContractPreflight(projectRoot),
    );
    const typecheckResult = await runLoggedStep(
      "Running local typecheck...",
      () => runLocalTypecheck(projectRoot),
    );
    if (typecheckResult.skipped) {
      if (typecheckResult.output) {
        consola.warn(typecheckResult.output);
      }
    } else if (!typecheckResult.success) {
      if (typecheckResult.output) {
        consola.error(typecheckResult.output);
      }
      throw new Error(
        "Local typecheck failed. Fix the diagnostics before syncing.",
      );
    }
    await runLoggedStep("Smoke-testing reducer bundle...", async () =>
      assertReducerBundleSmoke({
        projectRoot,
        manifest: localManifest,
      }),
    );
    consola.success("Reducer bundle smoke test passed.");

    const remoteProject = await runLoggedStep("Ensuring remote project...", () =>
      resolveRemoteProject({
        projectRoot,
        projectConfig: nextProjectConfig,
        config,
      }),
    );
    nextProjectConfig = remoteProject.projectConfig;

    const localDiff = await getLocalDiff(projectRoot);
    await assertCliStaticScaffoldComplete(projectRoot, localDiff.deleted);

    const localAuthoring = getProjectAuthoringState(nextProjectConfig);
    const pendingSync = getProjectPendingAuthoringSync(nextProjectConfig);
    const remoteHeadDigest = remoteProject.project.head?.revisionDigest;
    const localHeadDigest =
      localAuthoring.revisionDigest ?? nextProjectConfig.remoteHeadDigest;

    if (pendingSync && !parsedArgs.force) {
      throw new Error(
        "This workspace has an unfinished legacy sync checkpoint. Run 'dreamboard sync --force' to replace it with an atomic project revision.",
      );
    }

    if (
      remoteHeadDigest &&
      localHeadDigest &&
      remoteHeadDigest !== localHeadDigest
    ) {
      if (parsedArgs.force) {
        consola.warn(
          `Remote project head has moved to ${remoteHeadDigest}. --force will overwrite it with this workspace's local copy.`,
        );
      } else {
        throw new Error(
          `Remote project head has moved to ${remoteHeadDigest}. Run 'dreamboard pull' before syncing local changes, or pass --force to overwrite the remote with the local copy.`,
        );
      }
    }

    if (remoteHeadDigest && !localHeadDigest) {
      if (parsedArgs.force) {
        consola.warn(
          `This workspace has no authored base but the remote project head is ${remoteHeadDigest}. --force will overwrite it with this workspace's local copy.`,
        );
      } else {
        throw new Error(
          `This workspace has no authored base but the remote project head is ${remoteHeadDigest}. Re-clone, run 'dreamboard pull --force' into a clean workspace, or pass --force to overwrite the remote with the local copy.`,
        );
      }
    }

    const hasChanges =
      localDiff.modified.length > 0 ||
      localDiff.added.length > 0 ||
      localDiff.deleted.length > 0;
    const localManifestContentHash = computeManifestHash(localManifest);
    const manifestOutOfSync =
      localAuthoring.localManifestContentHash !== localManifestContentHash;
    if (
      !hasChanges &&
      !parsedArgs.force &&
      localHeadDigest != null &&
      remoteHeadDigest === localHeadDigest &&
      !pendingSync &&
      !manifestOutOfSync
    ) {
      consola.info("No local authored changes to sync.");
      return;
    }

    const localFiles = await collectLocalFiles(projectRoot);
    const sourceChanges = buildSourceSnapshotChanges(localFiles);
    const { changes } = await materializeSourceChangeOperations(sourceChanges);
    const uploadBlobs = mapUpsertBlobContentsByContentHash(
      sourceChanges,
      changes,
    );
    await uploadProjectSourceBlobsSdk(
      nextProjectConfig.projectId,
      Array.from(uploadBlobs.values()),
    );

    const sourceFiles = changes
      .filter((change) => change.kind === "upsert")
      .map(({ path, contentHash, byteSize }) => ({
        path,
        contentHash,
        byteSize,
      }));
    const revision = await createGameRevisionSdk({
      projectId: nextProjectConfig.projectId,
      request: {
        ...(remoteHeadDigest ? { baseRevisionDigest: remoteHeadDigest } : {}),
        source: { files: sourceFiles },
        ruleText: await loadRule(projectRoot),
        manifest: localManifest,
      },
    });
    nextProjectConfig = await persistProjectConfig({
      projectRoot,
      projectConfig: {
        ...updateProjectAuthoringState(nextProjectConfig, {
          revisionDigest: revision.revisionDigest,
          sourceTreeHash: revision.sourceTreeHash,
          manifestContentHash: revision.manifestContentHash,
          localManifestContentHash,
        }),
        remoteHeadDigest: revision.revisionDigest,
      },
    });
    nextProjectConfig = await finalizeLocalSync({
      projectRoot,
      projectConfig: nextProjectConfig,
    });

    consola.success(
      `Synced revision ${revision.revisionDigest}. Run 'dreamboard compile' when you're ready.`,
    );
  },
});
