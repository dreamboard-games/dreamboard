import { expect, mock, test } from "bun:test";

const ensureDir = mock(async () => undefined);
const scaffoldStaticWorkspace = mock(async () => undefined);
const pullIntoDirectory = mock(async () => undefined);
const installWorkspaceDependencies = mock(async () => undefined);
const updateProjectState = mock(async () => undefined);

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
  normalizeSlug: (value: string) => value,
}));

mock.module("../utils/fs.js", () => ({
  ensureDir,
}));

mock.module("../services/api/index.js", () => ({
  getProjectBySlugSdk: async () => ({
    projectId: "project-1",
    head: null,
  }),
  findProjectCompiledResultsForRevision: async () => [],
}));

mock.module("../config/project-config.js", () => ({
  updateProjectState,
}));

mock.module("../services/project/static-scaffold.js", () => ({
  scaffoldStaticWorkspace,
}));

mock.module("../services/project/sync.js", () => ({
  pullIntoDirectory,
}));

mock.module("../services/project/project-state.js", () => ({
  setLatestCompileAttempt: () => ({}),
  updateProjectLocalMaintainerRegistry: () => ({}),
}));

mock.module("../services/project/local-maintainer-registry.js", () => ({
  ensureLocalMaintainerSnapshot: async () => undefined,
  readWorkspaceLocalMaintainerRegistry: async () => undefined,
}));

mock.module("../services/project/workspace-dependencies.js", () => ({
  installWorkspaceDependencies,
}));

const cloneCommand = (await import("./clone.ts")).default;

test("clone command rejects projects without authored revisions before pulling files", async () => {
  ensureDir.mockClear();
  scaffoldStaticWorkspace.mockClear();
  pullIntoDirectory.mockClear();
  installWorkspaceDependencies.mockClear();
  updateProjectState.mockClear();

  await expect(
    cloneCommand.run({
      args: {
        slug: "test-game",
      },
    }),
  ).rejects.toThrow("Project 'test-game' has no authored revision to clone.");

  expect(ensureDir).toHaveBeenCalledTimes(1);
  expect(scaffoldStaticWorkspace).not.toHaveBeenCalled();
  expect(pullIntoDirectory).not.toHaveBeenCalled();
  expect(installWorkspaceDependencies).not.toHaveBeenCalled();
  expect(updateProjectState).not.toHaveBeenCalled();
});
