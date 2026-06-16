import { defineCommand } from "citty";
import consola from "consola";
import { updateProjectState } from "../config/project-config.js";
import { resolveProjectContext } from "../config/resolve.js";
import { parsePullCommandArgs } from "../flags.js";
import {
  buildRemoteAlignedSnapshotFiles,
  fetchLatestRemoteProjectSources,
  pullIntoDirectory,
  reconcileRemoteChangesIntoWorkspace,
} from "../services/project/sync.js";
import {
  collectLocalFiles,
  getLocalDiff,
  loadManifest,
  writeSnapshotFromFiles,
} from "../services/project/local-files.js";
import {
  getProjectAuthoringState,
  updateProjectLocalMaintainerRegistry,
  updateProjectAuthoringState,
} from "../services/project/project-state.js";
import { applyWorkspaceCodegen } from "../services/project/workspace-codegen.js";
import {
  ensureLocalMaintainerSnapshot,
  readWorkspaceLocalMaintainerRegistry,
} from "../services/project/local-maintainer-registry.js";
import { scaffoldStaticWorkspace } from "../services/project/static-scaffold.js";
import { installWorkspaceDependencies } from "../services/project/workspace-dependencies.js";
import { resolveRemoteProject } from "../services/project/remote-project.js";

export default defineCommand({
  meta: {
    name: "pull",
    description: "Reconcile remote authored changes into the current project",
  },
  args: {
    force: {
      type: "boolean",
      description: "Override conflicts",
      default: false,
    },
    env: { type: "string", description: "Environment: local | staging | prod" },
    token: {
      type: "string",
      description: "Auth token (Dreamboard bearer JWT)",
    },
  },
  async run({ args }) {
    const parsedArgs = parsePullCommandArgs(args);
    const { projectRoot, projectConfig, config } =
      await resolveProjectContext(parsedArgs);
    const remoteProject = await resolveRemoteProject({
      projectRoot,
      projectConfig,
      config,
    });
    const nextProjectConfig = remoteProject.projectConfig;
    const localMaintainerRegistry = await ensureLocalMaintainerSnapshot(
      config.apiBaseUrl,
    );
    const localAuthoring = getProjectAuthoringState(nextProjectConfig);
    const latestRemote = await fetchLatestRemoteProjectSources(
      nextProjectConfig.projectId,
    );

    if (localAuthoring.pendingSync && !parsedArgs.force) {
      throw new Error(
        "This workspace is still finalizing a previous sync. Run 'dreamboard sync' again to finish it, or use 'dreamboard pull --force' to replace local files with remote state.",
      );
    }

    if (!latestRemote) {
      consola.info("Remote has no authored state yet.");
      return;
    }

    const localRevisionDigest = localAuthoring.revisionDigest;
    const latestRevisionDigest =
      latestRemote.revisionDigest ?? remoteProject.project.head?.revisionDigest;

    if (!latestRevisionDigest) {
      throw new Error(
        "Remote has no project revision digest. Run 'dreamboard sync' first.",
      );
    }

    if (!localRevisionDigest) {
      if (!parsedArgs.force) {
        throw new Error(
          `This workspace has no authored base revision. Use 'dreamboard pull --force' to replace local files with remote revision ${latestRevisionDigest}.`,
        );
      }
      const pulledProjectConfig = await pullIntoDirectory(
        config,
        projectRoot,
        nextProjectConfig,
      );
      const fallbackRegistryUrl = localMaintainerRegistry?.registryUrl;
      const workspaceLocalMaintainerRegistry =
        localMaintainerRegistry ??
        (await readWorkspaceLocalMaintainerRegistry(
          projectRoot,
          fallbackRegistryUrl,
        ));
      await scaffoldStaticWorkspace(projectRoot, "update", {
        localMaintainerRegistry: workspaceLocalMaintainerRegistry,
      });
      if (workspaceLocalMaintainerRegistry) {
        await installWorkspaceDependencies(projectRoot);
        await updateProjectState(
          projectRoot,
          updateProjectLocalMaintainerRegistry(
            pulledProjectConfig,
            workspaceLocalMaintainerRegistry,
          ),
        );
      }
      consola.success("Pulled remote authored state into the workspace.");
      return;
    }

    if (localRevisionDigest === latestRevisionDigest) {
      consola.info("Remote project revision already matches this workspace.");
      return;
    }

    if (parsedArgs.force) {
      const pulledProjectConfig = await pullIntoDirectory(
        config,
        projectRoot,
        nextProjectConfig,
      );
      const fallbackRegistryUrl = localMaintainerRegistry?.registryUrl;
      const workspaceLocalMaintainerRegistry =
        localMaintainerRegistry ??
        (await readWorkspaceLocalMaintainerRegistry(
          projectRoot,
          fallbackRegistryUrl,
        ));
      await scaffoldStaticWorkspace(projectRoot, "update", {
        localMaintainerRegistry: workspaceLocalMaintainerRegistry,
      });
      if (workspaceLocalMaintainerRegistry) {
        await installWorkspaceDependencies(projectRoot);
        await updateProjectState(
          projectRoot,
          updateProjectLocalMaintainerRegistry(
            pulledProjectConfig,
            workspaceLocalMaintainerRegistry,
          ),
        );
      }
      consola.success(
        "Replaced local files with the current remote authored state.",
      );
      return;
    }

    const reconcileResult = await reconcileRemoteChangesIntoWorkspace({
      projectRoot,
      projectConfig: nextProjectConfig,
      baseRevisionDigest: localRevisionDigest,
      latestRevisionDigest,
    });

    if (reconcileResult.conflicts.length > 0) {
      for (const filePath of reconcileResult.conflicts) {
        consola.error(`Conflict: ${filePath}`);
      }
      throw new Error(
        `Remote reconciliation wrote conflict markers to ${reconcileResult.conflicts.length} file(s). Resolve them and rerun 'dreamboard pull'.`,
      );
    }

    await applyWorkspaceCodegen({
      projectRoot,
      manifest: await loadManifest(projectRoot),
    });
    const fallbackRegistryUrl = localMaintainerRegistry?.registryUrl;
    const workspaceLocalMaintainerRegistry =
      localMaintainerRegistry ??
      (await readWorkspaceLocalMaintainerRegistry(
        projectRoot,
        fallbackRegistryUrl,
      ));
    await scaffoldStaticWorkspace(projectRoot, "update", {
      localMaintainerRegistry: workspaceLocalMaintainerRegistry,
    });
    if (workspaceLocalMaintainerRegistry) {
      await installWorkspaceDependencies(projectRoot);
    }

    const reconciledProjectConfig = updateProjectLocalMaintainerRegistry(
      updateProjectAuthoringState(nextProjectConfig, {
        revisionDigest: latestRevisionDigest,
        authoringStateId: reconcileResult.latest.authoringStateId,
        sourceRevisionId: reconcileResult.latest.sourceRevisionId,
        sourceTreeHash: reconcileResult.latest.treeHash,
        manifestId:
          reconcileResult.latest.manifestId ??
          projectConfig.authoring?.manifestId,
        manifestContentHash:
          reconcileResult.latest.manifestContentHash ??
          projectConfig.authoring?.manifestContentHash,
        ruleId:
          reconcileResult.latest.ruleId ?? projectConfig.authoring?.ruleId,
      }),
      workspaceLocalMaintainerRegistry ?? undefined,
    );
    await updateProjectState(projectRoot, reconciledProjectConfig);

    const reconciledLocalFiles = await collectLocalFiles(projectRoot);
    await writeSnapshotFromFiles(
      projectRoot,
      buildRemoteAlignedSnapshotFiles({
        localFiles: reconciledLocalFiles,
        remoteUserFiles: reconcileResult.remoteUserFiles,
      }),
    );

    const localDiff = await getLocalDiff(projectRoot);
    if (
      localDiff.modified.length === 0 &&
      localDiff.added.length === 0 &&
      localDiff.deleted.length === 0
    ) {
      consola.success("Pulled remote authored changes.");
      return;
    }

    consola.success(
      "Pulled remote authored changes. Local edits were preserved where possible.",
    );
  },
});
