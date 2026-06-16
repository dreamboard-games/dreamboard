import {
  createGameRevision,
  createProjectSession,
  createProjectSessionFromReducerSnapshot,
  ensureProject,
  ensureProjectDevCompile,
  getApiVersion,
  getCurrentAuthUser,
  getProjectBySlug,
  getProjectRevisionSources,
  getProjectSources,
  type CreateSessionFromReducerSnapshotRequest,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CreateGameRevisionRequest,
  type EnsureDevCompileRequest,
  type EnsureDevCompileResponse,
  type GameRevision,
  type GameSourcesResponse,
  type HostSessionSnapshot,
  type Project,
  type ProjectRevisionSourcesResponse,
} from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";
import { titleFromSlug } from "../../utils/strings.js";

export type RemoteProjectIdentity = {
  deploymentId: string;
  ownerScopeId: string;
  bindingKey: string;
};

export async function loadRemoteProjectIdentity(): Promise<RemoteProjectIdentity> {
  const [versionResponse, userResponse] = await Promise.all([
    getApiVersion(),
    getCurrentAuthUser(),
  ]);

  if (versionResponse.error || !versionResponse.data) {
    throw toDreamboardApiError(
      versionResponse.error as Parameters<typeof toDreamboardApiError>[0],
      versionResponse.response,
      "Failed to resolve backend deployment identity",
    );
  }
  if (userResponse.error || !userResponse.data) {
    throw toDreamboardApiError(
      userResponse.error,
      userResponse.response,
      "Failed to resolve authenticated owner scope",
    );
  }

  const deploymentId = versionResponse.data.deploymentId;
  const ownerScopeId = userResponse.data.ownerScopeId;
  return {
    deploymentId,
    ownerScopeId,
    bindingKey: `${deploymentId}:${ownerScopeId}`,
  };
}

export async function ensureProjectSdk(options: {
  projectId: string;
  slug: string;
  description?: string;
  updateAlias?: boolean;
}): Promise<Project> {
  const { data, error, response } = await ensureProject({
    path: { projectId: options.projectId },
    body: {
      slug: options.slug,
      name: titleFromSlug(options.slug),
      description:
        options.description ?? `Dreamboard workspace for ${options.slug}.`,
      ...(options.updateAlias ? { updateAlias: true } : {}),
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to ensure project");
  }

  return data;
}

export async function getProjectBySlugSdk(slug: string): Promise<Project> {
  const { data, error, response } = await getProjectBySlug({
    path: { slug },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      `Project '${slug}' not found`,
    );
  }

  return data;
}

export async function createGameRevisionSdk(options: {
  projectId: string;
  request: CreateGameRevisionRequest;
}): Promise<GameRevision> {
  const { data, error, response } = await createGameRevision({
    path: { projectId: options.projectId },
    body: options.request,
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to create game revision",
    );
  }

  return data;
}

export async function getProjectSourcesSdk(
  projectId: string,
): Promise<GameSourcesResponse | null> {
  const { data, error, response } = await getProjectSources({
    path: { projectId },
  });

  if (response?.status === 404) {
    return null;
  }
  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to fetch project sources",
    );
  }

  return data;
}

export async function getProjectRevisionSourcesSdk(options: {
  projectId: string;
  revisionDigest: string;
}): Promise<ProjectRevisionSourcesResponse> {
  const { data, error, response } = await getProjectRevisionSources({
    path: {
      projectId: options.projectId,
      revisionDigest: options.revisionDigest,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to fetch project revision sources",
    );
  }

  return data;
}

export async function ensureProjectDevCompileSdk(options: {
  projectId: string;
  request: EnsureDevCompileRequest;
}): Promise<EnsureDevCompileResponse> {
  const { data, error, response } = await ensureProjectDevCompile({
    path: { projectId: options.projectId },
    body: options.request,
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to ensure dev compile");
  }

  return data;
}

export async function createProjectSessionSdk(options: {
  projectId: string;
  request: CreateSessionRequest;
}): Promise<CreateSessionResponse> {
  const { data, error, response } = await createProjectSession({
    path: { projectId: options.projectId },
    body: options.request,
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to create session");
  }

  return data;
}

export async function createProjectSessionFromReducerSnapshotSdk(options: {
  projectId: string;
  request: CreateSessionFromReducerSnapshotRequest;
}): Promise<HostSessionSnapshot> {
  const { data, error, response } =
    await createProjectSessionFromReducerSnapshot({
      path: { projectId: options.projectId },
      body: options.request,
    });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to create session from reducer snapshot",
    );
  }

  return data;
}
