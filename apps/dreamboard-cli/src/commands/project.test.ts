import { expect, mock, test } from "bun:test";
import type {
  ProjectCommitStatus,
  ProjectRepository,
} from "@dreamboard-games/api-client";

const retryProjectRepositoryReconciliationSdk = mock(
  async (): Promise<ProjectRepository> => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "REQUESTED",
    desiredGeneration: 2,
    observedGeneration: 1,
    retryable: false,
  }),
);
const getProjectRepositorySdk = mock(
  async (): Promise<ProjectRepository> => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "PROVISIONING",
    desiredGeneration: 2,
    observedGeneration: 1,
    retryable: false,
  }),
);
const pollProjectRepository = mock(
  async (): Promise<ProjectRepository> => ({
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState: "READY",
    desiredGeneration: 2,
    observedGeneration: 2,
    retryable: false,
  }),
);
const getProjectCommitStatusSdk = mock(
  async (): Promise<ProjectCommitStatus> => ({
    projectId: "project-1",
    commitOid: "0123456789abcdef",
    source: {
      observed: true,
      gitSourceRevisionId: "git-source-1",
      treeOid: "tree-1",
      refName: "refs/heads/main",
      validationStatus: "SUCCEEDED",
      validationDiagnostics: null,
      observedAt: "2026-06-19T00:00:00Z",
    },
    gameRevision: {
      gameRevisionId: "game-revision-1",
      revisionDigest: "sha256:revision",
      sourceTreeHash: "tree-hash",
    },
    builds: [],
    previews: [],
    releases: [],
  }),
);

mock.module("../config/resolve.js", () => ({
  resolveProjectContext: async () => ({
    projectRoot: "/workspace/project",
    projectConfig: {
      schemaVersion: 2,
      projectId: "project-1",
      slug: "project-1",
      gameId: "project-1",
      deploymentId: "deployment-1",
      ownerScopeId: "owner-1",
    },
    config: {
      environment: "prod",
      apiBaseUrl: "https://api.example.com",
      webBaseUrl: "https://web.example.com",
      authToken: "token",
      authTokenSource: "global",
      refreshTokenSource: "none",
    },
  }),
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

mock.module("../config/global-config.js", () => ({
  loadGlobalConfig: async () => ({}),
}));

mock.module("../config/credential-store.js", () => ({
  getStoredSession: async () => null,
}));

mock.module("../flags.js", () => ({
  parseProjectRepositoryCommandArgs: (args: Record<string, unknown>) => args,
  parseCommitScopedCommandArgs: (
    _commandName: string,
    args: Record<string, unknown>,
  ) => args,
  parseNewCommandArgs: (args: Record<string, unknown>) => args,
  parseCloneCommandArgs: (args: Record<string, unknown>) => args,
}));

mock.module("../services/api/index.js", () => ({
  ensureProjectRepositorySdk: async () => {
    throw new Error("unexpected ensure call");
  },
  ensureProjectSdk: async () => {
    throw new Error("unexpected project ensure call");
  },
  loadRemoteProjectIdentity: async () => {
    throw new Error("unexpected identity call");
  },
  getProjectBySlugSdk: async () => {
    throw new Error("unexpected project lookup call");
  },
  findProjectCompiledResultsForRevision: async () => {
    throw new Error("unexpected compiled result lookup call");
  },
  getProjectRepositorySdk,
  getProjectCommitStatusSdk,
  pollProjectRepository,
  retryProjectRepositoryReconciliationSdk,
}));

mock.module("@dreamboard-games/cli-core", () => ({
  configureDreamboardGitRepository: async () => undefined,
  SystemGit: class {
    async resolveCommit() {
      return "0123456789abcdef";
    }
  },
}));

const projectCommand = (await import("./project.ts")).default;

async function captureConsoleLog(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += `${args.map((arg) => String(arg)).join(" ")}\n`;
  };
  try {
    await run();
    return output;
  } finally {
    console.log = originalLog;
  }
}

test("project status waits on server commit status", async () => {
  getProjectRepositorySdk.mockClear();
  getProjectCommitStatusSdk.mockClear();
  retryProjectRepositoryReconciliationSdk.mockClear();
  pollProjectRepository.mockClear();
  getProjectCommitStatusSdk
    .mockResolvedValueOnce({
      projectId: "project-1",
      commitOid: "0123456789abcdef",
      source: {
        observed: true,
        gitSourceRevisionId: "git-source-1",
        treeOid: "tree-1",
        refName: "refs/heads/main",
        validationStatus: "PENDING",
        validationDiagnostics: null,
        observedAt: "2026-06-19T00:00:00Z",
      },
      gameRevision: {
        gameRevisionId: null,
        revisionDigest: null,
        sourceTreeHash: null,
      },
      builds: [],
      previews: [],
      releases: [],
    })
    .mockResolvedValueOnce({
      projectId: "project-1",
      commitOid: "0123456789abcdef",
      source: {
        observed: true,
        gitSourceRevisionId: "git-source-1",
        treeOid: "tree-1",
        refName: "refs/heads/main",
        validationStatus: "SUCCEEDED",
        validationDiagnostics: null,
        observedAt: "2026-06-19T00:00:01Z",
      },
      gameRevision: {
        gameRevisionId: "game-revision-1",
        revisionDigest: "sha256:revision",
        sourceTreeHash: "tree-hash",
      },
      builds: [],
      previews: [],
      releases: [],
    });
  const statusCommand = projectCommand.subCommands?.status as
    | { run?: (context: { args: unknown }) => Promise<void> }
    | undefined;

  const output = await captureConsoleLog(async () => {
    await statusCommand?.run?.({
      args: {
        commit: "HEAD",
        wait: true,
        "wait-timeout-ms": "2000",
        "status-poll-interval-ms": "25",
        json: true,
      },
    });
  });

  expect(getProjectCommitStatusSdk).toHaveBeenCalledTimes(2);
  expect(getProjectCommitStatusSdk).toHaveBeenCalledWith({
    projectId: "project-1",
    commitOid: "0123456789abcdef",
  });
  expect(getProjectRepositorySdk).not.toHaveBeenCalled();
  expect(retryProjectRepositoryReconciliationSdk).not.toHaveBeenCalled();
  expect(pollProjectRepository).not.toHaveBeenCalled();
  expect(JSON.parse(output)).toMatchObject({
    projectId: "project-1",
    commitOid: "0123456789abcdef",
    source: {
      validationStatus: "SUCCEEDED",
    },
  });
});
