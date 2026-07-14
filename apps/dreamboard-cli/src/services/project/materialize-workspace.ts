import path from "node:path";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import type {
  AgentMaintainerPackageSourceV1,
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
  deploymentId: string;
  ownerScopeId: string;
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
  maintainerPackageSource?: AgentMaintainerPackageSourceV1 | null;
  installDependencies?: boolean;
  agentManaged?: boolean;
  workspacePrepared?: boolean;
  allowCreateGame?: boolean;
  jobId?: string;
  environmentManifest?: Record<string, unknown>;
};

export async function materializeWorkspaceProject(
  input: MaterializeWorkspaceProjectInput,
): Promise<ProjectConfig> {
  const targetDir = path.resolve(input.targetDir);
  const localMaintainerRegistry = resolveLocalMaintainerRegistry(input);
  await ensureDir(targetDir);
  await writeManifest(targetDir, input.manifest);
  await writeRule(targetDir, input.ruleText);

  await scaffoldStaticWorkspace(targetDir, "new", {
    localMaintainerRegistry,
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
    localMaintainerRegistry ?? undefined,
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
    deploymentId: input.deploymentId,
    ownerScopeId: input.ownerScopeId,
    bindingKey: input.bindingKey,
    remoteHeadDigest: input.remoteHeadDigest ?? input.revisionDigest,
    slug: input.slug,
    jobId: input.jobId,
    agentManaged: input.agentManaged,
    workspacePrepared: input.workspacePrepared,
    allowCreateGame: input.allowCreateGame,
    apiBaseUrl: input.apiBaseUrl,
    webBaseUrl: input.webBaseUrl,
    environmentManifest: input.environmentManifest,
  };
}

function resolveLocalMaintainerRegistry(
  input: MaterializeWorkspaceProjectInput,
): LocalMaintainerRegistryConfig | null | undefined {
  if (input.localMaintainerRegistry) {
    return input.localMaintainerRegistry;
  }

  const source = input.maintainerPackageSource;
  if (!source) {
    return input.localMaintainerRegistry;
  }
  return localMaintainerRegistryFromSource(source);
}

export function localMaintainerRegistryFromSource(
  source: AgentMaintainerPackageSourceV1,
): LocalMaintainerRegistryConfig {
  if (source.version !== 1) {
    throw new Error(
      `Unsupported maintainer package source version: ${String(source.version)}`,
    );
  }
  return {
    registryUrl: source.registryUrl,
    snapshotId: source.snapshotId,
    fingerprint: source.fingerprint,
    publishedAt: source.publishedAt,
    packages: {
      ...(source.apiClientVersion
        ? { "@dreamboard-games/api-client": source.apiClientVersion }
        : {}),
      "@dreamboard-games/sdk": source.sdkVersion,
    },
  };
}
