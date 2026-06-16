import path from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import {
  resolveConfig,
  requireAuth,
  configureClient,
} from "../config/resolve.js";
import { parseCloneCommandArgs } from "../flags.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { normalizeSlug } from "../utils/strings.js";
import { ensureDir } from "../utils/fs.js";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  findProjectCompiledResultsForRevision,
  getProjectBySlugSdk,
} from "../services/api/index.js";
import { updateProjectState } from "../config/project-config.js";
import { scaffoldStaticWorkspace } from "../services/project/static-scaffold.js";
import { pullIntoDirectory } from "../services/project/sync.js";
import {
  setLatestCompileAttempt,
  updateProjectLocalMaintainerRegistry,
} from "../services/project/project-state.js";
import {
  ensureLocalMaintainerSnapshot,
  readWorkspaceLocalMaintainerRegistry,
} from "../services/project/local-maintainer-registry.js";
import { installWorkspaceDependencies } from "../services/project/workspace-dependencies.js";

export default defineCommand({
  meta: { name: "clone", description: "Clone an existing game by slug" },
  args: {
    slug: { type: "positional", description: "Game slug", required: true },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseCloneCommandArgs(args);
    const slugInput = parsedArgs.slug;

    const normalizedSlug = normalizeSlug(slugInput);
    if (!normalizedSlug) {
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
    const localMaintainerRegistry = await ensureLocalMaintainerSnapshot(
      config.apiBaseUrl,
    );

    const project = await getProjectBySlugSdk(normalizedSlug);
    const remoteHeadDigest = project.head?.revisionDigest;

    const targetDir = path.resolve(process.cwd(), normalizedSlug);
    await ensureDir(targetDir);

    if (!remoteHeadDigest) {
      throw new Error(
        `Project '${normalizedSlug}' has no authored revision to clone.`,
      );
    }

      await scaffoldStaticWorkspace(targetDir, "update", {
        localMaintainerRegistry,
      });
      await installWorkspaceDependencies(targetDir);
      const pulledProjectConfig = await pullIntoDirectory(config, targetDir, {
        schemaVersion: 2,
        projectId: project.projectId,
        gameId: project.projectId,
        deploymentId: "project",
        ownerScopeId: "default",
        slug: normalizedSlug,
        remoteHeadDigest,
        apiBaseUrl: config.apiBaseUrl,
        webBaseUrl: config.webBaseUrl,
      });
      const fallbackRegistryUrl = localMaintainerRegistry?.registryUrl;
      const workspaceLocalMaintainerRegistry =
        localMaintainerRegistry ??
        (await readWorkspaceLocalMaintainerRegistry(
          targetDir,
          fallbackRegistryUrl,
        ));
      await scaffoldStaticWorkspace(targetDir, "update", {
        localMaintainerRegistry: workspaceLocalMaintainerRegistry,
      });
      if (workspaceLocalMaintainerRegistry) {
        await installWorkspaceDependencies(targetDir);
      }
      await updateProjectState(
        targetDir,
        updateProjectLocalMaintainerRegistry(
          pulledProjectConfig,
          workspaceLocalMaintainerRegistry ?? undefined,
        ),
      );

      const remoteResults = await findProjectCompiledResultsForRevision({
        projectId: project.projectId,
        revisionDigest: remoteHeadDigest,
      });
      const latestSuccess = remoteResults.find(
        (result: { success: boolean }) => result.success,
      );
      if (latestSuccess) {
        const configWithLatestCompileAttempt = setLatestCompileAttempt(
          pulledProjectConfig,
          {
            resultId: latestSuccess.id,
            authoringStateId: latestSuccess.authoringStateId ?? remoteHeadDigest,
            revisionDigest: remoteHeadDigest,
            status: "successful",
          },
        );
        await updateProjectState(
          targetDir,
          updateProjectLocalMaintainerRegistry(
            configWithLatestCompileAttempt,
            workspaceLocalMaintainerRegistry ?? undefined,
          ),
        );
      }

    consola.success(`Cloned ${normalizedSlug} into ${targetDir}`);
  },
});
