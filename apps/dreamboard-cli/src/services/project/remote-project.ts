import type { Project } from "@dreamboard-games/api-client";
import { updateProjectState } from "../../config/project-config.js";
import type { ProjectConfig, ResolvedConfig } from "../../types.js";
import {
  ensureProjectSdk,
  loadRemoteProjectIdentity,
  type RemoteProjectIdentity,
} from "../api/index.js";

export type ResolvedRemoteProject = {
  identity: RemoteProjectIdentity;
  project: Project;
  projectConfig: ProjectConfig;
};

export async function resolveRemoteProject(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  config: Pick<ResolvedConfig, "apiBaseUrl" | "webBaseUrl">;
  updateAlias?: boolean;
}): Promise<ResolvedRemoteProject> {
  const identity = await loadRemoteProjectIdentity();
  const project = await ensureProjectSdk({
    projectId: options.projectConfig.projectId,
    slug: options.projectConfig.slug,
    updateAlias: options.updateAlias,
  });
  const nextProjectConfig: ProjectConfig = {
    ...options.projectConfig,
    slug: project.slug,
    deploymentId: identity.deploymentId,
    ownerScopeId: identity.ownerScopeId,
    bindingKey: identity.bindingKey,
    remoteHeadDigest: project.head?.revisionDigest,
    apiBaseUrl: options.config.apiBaseUrl,
    webBaseUrl: options.config.webBaseUrl,
  };

  await updateProjectState(options.projectRoot, nextProjectConfig);

  return {
    identity,
    project,
    projectConfig: nextProjectConfig,
  };
}
