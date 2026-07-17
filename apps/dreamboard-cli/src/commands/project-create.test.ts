import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const tempHomes: string[] = [];
const originalHome = process.env.HOME;
let uuidIndex = 0;

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
const createUuidV7 = mock(() => {
  uuidIndex += 1;
  return `project-uuid-${uuidIndex}`;
});

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
  createUuidV7,
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

const createCommand = (await import("./project-create.ts")).default;

beforeEach(async () => {
  uuidIndex = 0;
  createUuidV7.mockClear();
  ensureProjectSdk.mockImplementation(async () => ({
    projectId: "project-1",
    slug: "test-game",
    head: {
      revisionDigest: "revision-digest-1",
    },
  }));
  ensureProjectRepositorySdk.mockImplementation(async () => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "REQUESTED" as const,
    desiredGeneration: 1,
    observedGeneration: 0,
    retryable: false,
  }));
  pollProjectRepository.mockImplementation(async () => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "READY" as const,
    desiredGeneration: 1,
    observedGeneration: 1,
    retryable: false,
  }));
  materializeWorkspaceProject.mockImplementation(async () => undefined);
  configureWorkspaceGitOrigin.mockImplementation(async () => undefined);
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "dreamboard-cli-home-"));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await Promise.all(
    tempHomes.map((home) => rm(home, { recursive: true, force: true })),
  );
});

test("project create command materializes a project-bound workspace", async () => {
  ensureProjectSdk.mockClear();
  ensureProjectRepositorySdk.mockClear();
  pollProjectRepository.mockClear();
  materializeWorkspaceProject.mockClear();
  configureWorkspaceGitOrigin.mockClear();
  createUuidV7.mockClear();

  await createCommand.run({
    args: {
      slug: "test-game",
      description: "A test game",
    },
  });

  expect(ensureProjectSdk).toHaveBeenCalledWith({
    projectId: "project-uuid-2",
    slug: "test-game",
    description: "A test game",
  });
  expect(ensureProjectRepositorySdk).toHaveBeenCalledWith("project-uuid-2");
  expect(pollProjectRepository).toHaveBeenCalledWith({
    projectId: "project-uuid-2",
    timeoutMs: 120000,
    intervalMs: 1000,
  });
  expect(materializeWorkspaceProject).toHaveBeenCalledTimes(1);
  const materializeArgs = materializeWorkspaceProject.mock.calls[0]?.[0] as {
    targetDir: string;
    projectId: string;
    deploymentId: string;
    ownerScopeId: string;
    bindingKey: string;
    remoteHeadDigest?: string;
    apiBaseUrl: string;
    webBaseUrl: string;
  };
  expect(materializeArgs.targetDir.endsWith("/test-game")).toBe(true);
  expect(materializeArgs.projectId).toBe("project-uuid-2");
  expect(materializeArgs.deploymentId).toBe("deployment-1");
  expect(materializeArgs.ownerScopeId).toBe("owner-scope-1");
  expect(materializeArgs.bindingKey).toBe("deployment-1:owner-scope-1");
  expect(materializeArgs.remoteHeadDigest).toBe("revision-digest-1");
  expect(materializeArgs.apiBaseUrl).toBe("https://api.example.com");
  expect(materializeArgs.webBaseUrl).toBe("https://web.example.com");
  expect(configureWorkspaceGitOrigin).toHaveBeenCalledWith({
    projectRoot: materializeArgs.targetDir,
    cloneUrl: "https://git.example.com/project-1.git",
  });
});

test("project create resumes an incomplete journal with the same project id", async () => {
  ensureProjectSdk.mockClear();
  createUuidV7.mockClear();
  ensureProjectSdk.mockRejectedValueOnce(new Error("socket closed"));

  await expect(
    createCommand.run({
      args: {
        slug: "test-game",
        description: "A test game",
      },
    }),
  ).rejects.toThrow("socket closed");

  expect(ensureProjectSdk).toHaveBeenCalledWith({
    projectId: "project-uuid-2",
    slug: "test-game",
    description: "A test game",
  });

  await createCommand.run({
    args: {
      slug: "test-game",
      description: "A test game",
    },
  });

  expect(ensureProjectSdk).toHaveBeenLastCalledWith({
    projectId: "project-uuid-2",
    slug: "test-game",
    description: "A test game",
  });
});
