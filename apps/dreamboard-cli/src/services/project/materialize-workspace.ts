import path from "node:path";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import type {
  LocalMaintainerRegistryConfig,
  ProjectConfig,
} from "../../types.js";
import { ensureDir } from "../../utils/fs.js";
import { writeManifest, writeRule, writeSnapshot } from "./local-files.js";
import { scaffoldStaticWorkspace } from "./static-scaffold.js";
import { applyWorkspaceCodegen } from "./workspace-codegen.js";
import { installWorkspaceDependencies } from "./workspace-dependencies.js";
import {
  updateProjectAuthoringState,
  updateProjectLocalMaintainerRegistry,
} from "./project-state.js";
import { updateProjectState } from "../../config/project-config.js";

export type MaterializeWorkspaceProjectInput = {
  targetDir: string;
  projectId: string;
  slug: string;
  deploymentId?: string;
  ownerScopeId?: string;
  bindingKey?: string;
  remoteHeadDigest?: string;
  apiBaseUrl: string;
  webBaseUrl: string;
  manifest: GameTopologyManifest;
  ruleText: string;
  gameRevisionId?: string;
  revisionDigest?: string;
  sourceRevisionId?: string;
  sourceTreeHash?: string;
  manifestContentHash?: string;
  localMaintainerRegistry?: LocalMaintainerRegistryConfig | null;
  installDependencies?: boolean;
  agentManaged?: boolean;
  workspacePrepared?: boolean;
  allowCreateGame?: boolean;
  jobId?: string;
  packageManifest?: Record<string, unknown>;
  environmentManifest?: Record<string, unknown>;
};

export async function materializeWorkspaceProject(
  input: MaterializeWorkspaceProjectInput,
): Promise<ProjectConfig> {
  const targetDir = path.resolve(input.targetDir);
  await ensureDir(targetDir);
  await writeManifest(targetDir, input.manifest);
  await writeRule(targetDir, input.ruleText);

  await scaffoldStaticWorkspace(targetDir, "new", {
    localMaintainerRegistry: input.localMaintainerRegistry,
  });
  if (input.installDependencies ?? true) {
    await installWorkspaceDependencies(targetDir);
    await applyWorkspaceCodegen({
      projectRoot: targetDir,
      manifest: input.manifest,
    });
  }

  const baseConfig = baseProjectConfig(input);
  const authoringConfig =
    input.gameRevisionId ||
    input.revisionDigest ||
    input.sourceRevisionId ||
    input.sourceTreeHash ||
    input.manifestContentHash
      ? updateProjectAuthoringState(baseConfig, {
          gameRevisionId: input.gameRevisionId,
          revisionDigest: input.revisionDigest,
          sourceRevisionId: input.sourceRevisionId,
          sourceTreeHash: input.sourceTreeHash,
          manifestContentHash: input.manifestContentHash,
        })
      : baseConfig;
  const projectConfig = updateProjectLocalMaintainerRegistry(
    authoringConfig,
    input.localMaintainerRegistry ?? undefined,
  );
  await updateProjectState(targetDir, projectConfig);
  await writeSnapshot(targetDir);
  return projectConfig;
}

function baseProjectConfig(
  input: MaterializeWorkspaceProjectInput,
): ProjectConfig {
  return {
    schemaVersion: 2,
    projectId: input.projectId,
    deploymentId: input.deploymentId ?? "legacy",
    ownerScopeId: input.ownerScopeId ?? "default",
    bindingKey: input.bindingKey,
    remoteHeadDigest: input.remoteHeadDigest ?? input.revisionDigest,
    slug: input.slug,
    jobId: input.jobId,
    agentManaged: input.agentManaged,
    workspacePrepared: input.workspacePrepared,
    allowCreateGame: input.allowCreateGame,
    apiBaseUrl: input.apiBaseUrl,
    webBaseUrl: input.webBaseUrl,
    packageManifest: input.packageManifest,
    environmentManifest: input.environmentManifest,
  };
}
