import { expect, mock, test } from "bun:test";
import { AUTHORING_RELEASE_SET } from "../release/authoring-release-set.js";

const ensureProjectSdk = mock(async () => ({
  projectId: "project-1",
  slug: "test-game",
  head: {
    revisionDigest: "revision-digest-1",
  },
}));
const ensureProjectRepositorySdk = mock(async () => ({
  repoBindingId: "repo-binding-1",
  cloneUrl: "https://git.example.com/project-1.git",
  defaultBranch: "main",
  headCommit: "",
  provisioningState: "REQUESTED" as const,
  desiredGeneration: 1,
  observedGeneration: 0,
  retryable: false,
}));
const pollProjectRepository = mock(async () => ({
  repoBindingId: "repo-binding-1",
  cloneUrl: "https://git.example.com/project-1.git",
  defaultBranch: "main",
  headCommit: "",
  provisioningState: "READY" as const,
  desiredGeneration: 1,
  observedGeneration: 1,
  retryable: false,
}));
const materializeWorkspaceProject = mock(async () => undefined);
const configureWorkspaceGitOrigin = mock(async () => undefined);

mock.module("../config/resolve.js", () => ({
  resolveConfig: () => ({
    environment: "prod",
    apiBaseUrl: "https://api.example.com",
    webBaseUrl: "https://web.example.com",
    authToken: "token",
    authTokenSource: "global",
    refreshTokenSource: "none",
  }),
  requireAuth: () => undefined,
  configureClient: async () => undefined,
}));

mock.module("../flags.js", () => ({
  parseNewCommandArgs: (args: Record<string, unknown>) => args,
}));

mock.module("../config/global-config.js", () => ({
  loadGlobalConfig: async () => ({}),
}));

mock.module("../config/credential-store.js", () => ({
  getStoredSession: async () => null,
}));

mock.module("../utils/strings.js", () => ({
  normalizeSlug: (value: string) => value,
}));

mock.module("../utils/uuid-v7.js", () => ({
  createUuidV7: () => "project-uuid-1",
}));

mock.module("../services/api/index.js", () => ({
  ensureProjectRepositorySdk,
  ensureProjectSdk,
  loadRemoteProjectIdentity: async () => ({
    deploymentId: "deployment-1",
    ownerScopeId: "owner-scope-1",
    bindingKey: "deployment-1:owner-scope-1",
  }),
  pollProjectRepository,
}));

mock.module("../services/project/materialize-workspace.js", () => ({
  materializeWorkspaceProject,
}));

mock.module("../services/git/workspace-origin.js", () => ({
  configureWorkspaceGitOrigin,
}));

mock.module("../services/project/local-maintainer-registry.js", () => ({
  ensureLocalMaintainerSnapshot: async () => ({
    registryUrl: "https://registry.npmjs.org/",
    snapshotId: "public",
    fingerprint: "public",
    publishedAt: "2026-06-16T00:00:00.000Z",
    packages: {
      "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
    },
  }),
}));

const newCommand = (await import("./new.ts")).default;

test("new command materializes a project-bound workspace", async () => {
  ensureProjectSdk.mockClear();
  ensureProjectRepositorySdk.mockClear();
  pollProjectRepository.mockClear();
  materializeWorkspaceProject.mockClear();
  configureWorkspaceGitOrigin.mockClear();

  await newCommand.run({
    args: {
      slug: "test-game",
      description: "A test game",
      force: false,
    },
  });

  expect(ensureProjectSdk).toHaveBeenCalledWith({
    projectId: "project-uuid-1",
    slug: "test-game",
    description: "A test game",
    updateAlias: false,
  });
  expect(ensureProjectRepositorySdk).toHaveBeenCalledWith("project-1");
  expect(pollProjectRepository).toHaveBeenCalledWith({
    projectId: "project-1",
    timeoutMs: 120000,
    intervalMs: 1000,
  });
  expect(materializeWorkspaceProject).toHaveBeenCalledTimes(1);
  const materializeArgs = materializeWorkspaceProject.mock.calls[0]?.[0] as {
    targetDir: string;
    projectId: string;
    gameId: string;
    deploymentId: string;
    ownerScopeId: string;
    bindingKey: string;
    remoteHeadDigest?: string;
    apiBaseUrl: string;
    webBaseUrl: string;
    localMaintainerRegistry?: {
      packages: Record<string, string>;
    };
  };
  expect(materializeArgs.targetDir.endsWith("/test-game")).toBe(true);
  expect(materializeArgs.projectId).toBe("project-uuid-1");
  expect(materializeArgs.gameId).toBe("project-1");
  expect(materializeArgs.deploymentId).toBe("deployment-1");
  expect(materializeArgs.ownerScopeId).toBe("owner-scope-1");
  expect(materializeArgs.bindingKey).toBe("deployment-1:owner-scope-1");
  expect(materializeArgs.remoteHeadDigest).toBe("revision-digest-1");
  expect(materializeArgs.apiBaseUrl).toBe("https://api.example.com");
  expect(materializeArgs.webBaseUrl).toBe("https://web.example.com");
  expect(materializeArgs.localMaintainerRegistry?.packages).toEqual({
    "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
  });
  expect(configureWorkspaceGitOrigin).toHaveBeenCalledWith({
    projectRoot: materializeArgs.targetDir,
    cloneUrl: "https://git.example.com/project-1.git",
  });
});
