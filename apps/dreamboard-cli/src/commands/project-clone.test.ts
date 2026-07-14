import { expect, mock, test } from "bun:test";

const mkdtemp = mock(async () => "/tmp/.test-game.dreamboard-clone-abc");
const rename = mock(async () => undefined);
const rm = mock(async () => undefined);
const exists = mock(async () => false);
const cloneDreamboardGitRepository = mock(async () => undefined);
const installFrozenWorkspaceDependencies = mock(async () => undefined);
const loadManifest = mock(async () => ({ players: { minPlayers: 2 } }));
const writeSnapshot = mock(async () => undefined);
const resolveCommit = mock(async () => "abc123");
const statusPorcelain = mock(async () => "");
const updateProjectEnvironmentState = mock(async () => undefined);
const loadProjectConfig = mock(async () => ({
  schemaVersion: 2,
  projectId: "project-1",
  slug: "test-game",
}));
const getProjectBySlugSdk = mock(async () => ({
  projectId: "project-1",
  slug: "test-game",
  head: { revisionDigest: "revision-digest-1" },
}));
const ensureProjectRepositorySdk = mock(async () => ({
  repoBindingId: "repo-binding-1",
  cloneUrl: "https://git.example.com/project-1.git",
  defaultBranch: "main",
  headCommit: "abc123",
  provisioningState: "READY" as const,
  desiredGeneration: 1,
  observedGeneration: 1,
  retryable: false,
}));
const pollProjectRepository = mock(async () => ({
  repoBindingId: "repo-binding-1",
  cloneUrl: "https://git.example.com/project-1.git",
  defaultBranch: "main",
  headCommit: "abc123",
  provisioningState: "READY" as const,
  desiredGeneration: 1,
  observedGeneration: 1,
  retryable: false,
}));

mock.module("node:fs/promises", () => ({
  mkdtemp,
  rename,
  rm,
}));

mock.module("../config/resolve.js", () => ({
  resolveConfig: () => ({
    apiBaseUrl: "https://api.example.com",
    webBaseUrl: "https://web.example.com",
    environment: "prod",
    authToken: "token",
  }),
  requireAuth: () => undefined,
  configureClient: async () => undefined,
}));

mock.module("../flags.js", () => ({
  parseCloneCommandArgs: (args: Record<string, unknown>) => args,
}));

mock.module("../config/global-config.js", () => ({
  loadGlobalConfig: async () => ({}),
}));

mock.module("../config/credential-store.js", () => ({
  getStoredSession: async () => null,
}));

mock.module("../utils/strings.js", () => ({
  normalizeSlug: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
}));

mock.module("../utils/fs.js", () => ({
  exists,
}));

mock.module("@dreamboard-games/cli-core", () => ({
  SystemGit: class {
    resolveCommit = resolveCommit;
    statusPorcelain = statusPorcelain;
  },
}));

mock.module("../services/api/index.js", () => ({
  ensureProjectRepositorySdk,
  getProjectBySlugSdk,
  loadRemoteProjectIdentity: async () => ({
    deploymentId: "deployment-1",
    ownerScopeId: "owner-scope-1",
    bindingKey: "deployment-1:owner-scope-1",
  }),
  pollProjectRepository,
}));

mock.module("../config/project-config.js", () => ({
  loadProjectConfig,
  updateProjectEnvironmentState,
}));

mock.module("../services/git/workspace-origin.js", () => ({
  cloneDreamboardGitRepository,
}));

mock.module("../services/project/workspace-dependencies.js", () => ({
  installFrozenWorkspaceDependencies,
}));

mock.module("../services/project/local-files.js", () => ({
  loadManifest,
  writeSnapshot,
}));

const cloneCommand = (await import("./project-clone.ts")).default;

function clearMocks() {
  mkdtemp.mockClear();
  rename.mockClear();
  rm.mockClear();
  exists.mockClear();
  cloneDreamboardGitRepository.mockClear();
  installFrozenWorkspaceDependencies.mockClear();
  loadManifest.mockClear();
  writeSnapshot.mockClear();
  resolveCommit.mockClear();
  statusPorcelain.mockClear();
  updateProjectEnvironmentState.mockClear();
  loadProjectConfig.mockClear();
  getProjectBySlugSdk.mockClear();
  ensureProjectRepositorySdk.mockClear();
  pollProjectRepository.mockClear();
}

test("project clone rejects uninitialized repositories before cloning", async () => {
  clearMocks();
  pollProjectRepository.mockImplementationOnce(async () => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "READY" as const,
    desiredGeneration: 1,
    observedGeneration: 1,
    retryable: false,
  }));

  await expect(
    cloneCommand.run({
      args: {
        slug: "test-game",
      },
    }),
  ).rejects.toThrow("PROJECT_UNINITIALIZED");

  expect(ensureProjectRepositorySdk).toHaveBeenCalledWith("project-1");
  expect(mkdtemp).not.toHaveBeenCalled();
  expect(cloneDreamboardGitRepository).not.toHaveBeenCalled();
  expect(installFrozenWorkspaceDependencies).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
});

test("project clone uses native Git clone and verifies tracked project identity", async () => {
  clearMocks();

  await cloneCommand.run({
    args: {
      slug: "owner/test-game",
    },
  });

  expect(getProjectBySlugSdk).toHaveBeenCalledWith("test-game");
  expect(pollProjectRepository).toHaveBeenCalledWith({
    projectId: "project-1",
    timeoutMs: 120000,
    intervalMs: 1000,
  });
  expect(mkdtemp).toHaveBeenCalledWith(
    expect.stringContaining(".test-game.dreamboard-clone-"),
  );
  expect(cloneDreamboardGitRepository).toHaveBeenCalledWith({
    cloneUrl: "https://git.example.com/project-1.git",
    destination: "/tmp/.test-game.dreamboard-clone-abc",
  });
  expect(resolveCommit).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
    "HEAD",
  );
  expect(loadProjectConfig).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
  );
  expect(updateProjectEnvironmentState).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
    expect.objectContaining({
      projectId: "project-1",
      deploymentId: "deployment-1",
      ownerScopeId: "owner-scope-1",
      bindingKey: "deployment-1:owner-scope-1",
      remoteHeadDigest: "revision-digest-1",
      apiBaseUrl: "https://api.example.com",
      webBaseUrl: "https://web.example.com",
    }),
  );
  expect(installFrozenWorkspaceDependencies).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
  );
  expect(loadManifest).toHaveBeenCalledWith("/tmp/.test-game.dreamboard-clone-abc");
  expect(writeSnapshot).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
  );
  expect(statusPorcelain).toHaveBeenCalledWith(
    "/tmp/.test-game.dreamboard-clone-abc",
  );
  expect(rename.mock.calls[0]?.[0]).toBe("/tmp/.test-game.dreamboard-clone-abc");
  expect(String(rename.mock.calls[0]?.[1])).toEndWith("/test-game");
  expect(rm).not.toHaveBeenCalled();
});

test("project clone removes temporary checkout when cloned HEAD is stale", async () => {
  clearMocks();
  resolveCommit.mockImplementationOnce(async () => "stale");

  await expect(
    cloneCommand.run({
      args: {
        slug: "test-game",
      },
    }),
  ).rejects.toThrow("Cloned repository HEAD mismatch");

  expect(rm).toHaveBeenCalledWith("/tmp/.test-game.dreamboard-clone-abc", {
    recursive: true,
    force: true,
  });
  expect(loadProjectConfig).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
});

test("project clone removes temporary checkout when project identity mismatches", async () => {
  clearMocks();
  loadProjectConfig.mockImplementationOnce(async () => ({
    schemaVersion: 2,
    projectId: "different-project",
    slug: "test-game",
  }));

  await expect(
    cloneCommand.run({
      args: {
        slug: "test-game",
      },
    }),
  ).rejects.toThrow("Cloned repository projectId mismatch");

  expect(rm).toHaveBeenCalledWith("/tmp/.test-game.dreamboard-clone-abc", {
    recursive: true,
    force: true,
  });
  expect(rename).not.toHaveBeenCalled();
});

test("project clone rejects tracked mutations before publishing checkout", async () => {
  clearMocks();
  statusPorcelain.mockImplementationOnce(async () => " M package.json");

  await expect(
    cloneCommand.run({
      args: {
        slug: "test-game",
      },
    }),
  ).rejects.toThrow("Refusing to publish a mutated checkout");

  expect(rm).toHaveBeenCalledWith("/tmp/.test-game.dreamboard-clone-abc", {
    recursive: true,
    force: true,
  });
  expect(rename).not.toHaveBeenCalled();
});
