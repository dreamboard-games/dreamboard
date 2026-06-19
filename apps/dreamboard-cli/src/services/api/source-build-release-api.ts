import {
  createProjectPreview,
  ensureProjectBuild,
  getCurrentProjectRelease,
  getProjectCommitStatus,
  publishProjectRelease,
  type ProjectBuild,
  type ProjectBuildTargetProfile,
  type ProjectCommitStatus,
  type ProjectPreview,
  type ProjectRelease,
} from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";

export async function ensureProjectBuildSdk(options: {
  projectId: string;
  commitOid: string;
  targetProfile: ProjectBuildTargetProfile;
}): Promise<ProjectBuild> {
  const { data, error, response } = await ensureProjectBuild({
    path: { projectId: options.projectId },
    body: {
      commitOid: options.commitOid,
      targetProfile: options.targetProfile,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to ensure project build");
  }

  return data;
}

export async function createProjectPreviewSdk(options: {
  projectId: string;
  commitOid: string;
}): Promise<ProjectPreview> {
  const { data, error, response } = await createProjectPreview({
    path: { projectId: options.projectId },
    body: {
      commitOid: options.commitOid,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to create project preview",
    );
  }

  return data;
}

export async function getProjectCommitStatusSdk(options: {
  projectId: string;
  commitOid: string;
}): Promise<ProjectCommitStatus> {
  const { data, error, response } = await getProjectCommitStatus({
    path: {
      projectId: options.projectId,
      commitOid: options.commitOid,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to get project commit status",
    );
  }

  return data;
}

export async function publishProjectReleaseSdk(options: {
  projectId: string;
  commitOid: string;
}): Promise<ProjectRelease> {
  const { data, error, response } = await publishProjectRelease({
    path: { projectId: options.projectId },
    body: {
      commitOid: options.commitOid,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to publish project release",
    );
  }

  return data;
}

export async function getCurrentProjectReleaseSdk(options: {
  projectId: string;
}): Promise<ProjectRelease> {
  const { data, error, response } = await getCurrentProjectRelease({
    path: { projectId: options.projectId },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to get current project release",
    );
  }

  return data;
}
