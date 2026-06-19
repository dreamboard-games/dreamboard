import { beforeEach, expect, mock, test } from "bun:test";
import type { ProjectRepository } from "@dreamboard-games/api-client";

mock.restore();

type MockApiResponse<T> = {
  data: T | null;
  error: { message: string } | null;
  response: { status: number };
};

function repository(
  provisioningState: ProjectRepository["provisioningState"],
  overrides: Partial<ProjectRepository> = {},
): ProjectRepository {
  return {
    repoBindingId: "repo-binding-1",
    cloneUrl: "https://git.example.com/project-1.git",
    defaultBranch: "main",
    headCommit: "",
    provisioningState,
    desiredGeneration: 1,
    observedGeneration: provisioningState === "READY" ? 1 : 0,
    retryable: provisioningState === "ERROR",
    ...overrides,
  };
}

const mockState: {
  ensureResponse: MockApiResponse<ProjectRepository>;
  getResponse: MockApiResponse<ProjectRepository>;
  retryResponse: MockApiResponse<ProjectRepository>;
  calls: Array<{ name: string; projectId: string }>;
} = {
  ensureResponse: {
    data: repository("REQUESTED"),
    error: null,
    response: { status: 200 },
  },
  getResponse: {
    data: repository("READY"),
    error: null,
    response: { status: 200 },
  },
  retryResponse: {
    data: repository("REQUESTED", { desiredGeneration: 2 }),
    error: null,
    response: { status: 200 },
  },
  calls: [],
};

mock.module("@dreamboard-games/api-client", () => ({
  ensureProjectRepository: async (options: { path: { projectId: string } }) => {
    mockState.calls.push({
      name: "ensure",
      projectId: options.path.projectId,
    });
    return mockState.ensureResponse;
  },
  getProjectRepository: async (options: { path: { projectId: string } }) => {
    mockState.calls.push({
      name: "get",
      projectId: options.path.projectId,
    });
    return mockState.getResponse;
  },
  retryProjectRepositoryReconciliation: async (options: {
    path: { projectId: string };
  }) => {
    mockState.calls.push({
      name: "retry",
      projectId: options.path.projectId,
    });
    return mockState.retryResponse;
  },
}));

const {
  ensureProjectRepositorySdk,
  getProjectRepositorySdk,
  pollProjectRepository,
  ProjectRepositoryTimeoutError,
  retryProjectRepositoryReconciliationSdk,
} = await import("./project-repository-api.ts");

beforeEach(() => {
  mockState.ensureResponse = {
    data: repository("REQUESTED"),
    error: null,
    response: { status: 200 },
  };
  mockState.getResponse = {
    data: repository("READY"),
    error: null,
    response: { status: 200 },
  };
  mockState.retryResponse = {
    data: repository("REQUESTED", { desiredGeneration: 2 }),
    error: null,
    response: { status: 200 },
  };
  mockState.calls = [];
});

test("repository wrappers call generated endpoints with project id", async () => {
  await ensureProjectRepositorySdk("project-1");
  await getProjectRepositorySdk("project-1");
  await retryProjectRepositoryReconciliationSdk("project-1");

  expect(mockState.calls).toEqual([
    { name: "ensure", projectId: "project-1" },
    { name: "get", projectId: "project-1" },
    { name: "retry", projectId: "project-1" },
  ]);
});

test("getProjectRepositorySdk returns null for missing bindings", async () => {
  mockState.getResponse = {
    data: null,
    error: { message: "missing" },
    response: { status: 404 },
  };

  await expect(getProjectRepositorySdk("project-1")).resolves.toBeNull();
});

test("pollProjectRepository returns READY after bounded polling", async () => {
  const sequence = [
    repository("REQUESTED"),
    repository("PROVISIONING"),
    repository("READY"),
  ];
  let now = 0;

  const result = await pollProjectRepository({
    projectId: "project-1",
    timeoutMs: 5_000,
    intervalMs: 100,
    fetchRepository: async () => sequence.shift() ?? repository("READY"),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });

  expect(result.provisioningState).toBe("READY");
});

test("pollProjectRepository returns terminal repository errors", async () => {
  const result = await pollProjectRepository({
    projectId: "project-1",
    timeoutMs: 5_000,
    fetchRepository: async () =>
      repository("ERROR", { errorCode: "FORGEJO_DOWN" }),
    sleep: async () => undefined,
    now: () => 0,
  });

  expect(result.provisioningState).toBe("ERROR");
  expect(result.errorCode).toBe("FORGEJO_DOWN");
});

test("pollProjectRepository throws when the binding never reaches terminal state", async () => {
  let now = 0;

  await expect(
    pollProjectRepository({
      projectId: "project-1",
      timeoutMs: 100,
      intervalMs: 50,
      fetchRepository: async () => repository("PROVISIONING"),
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    }),
  ).rejects.toBeInstanceOf(ProjectRepositoryTimeoutError);
});
