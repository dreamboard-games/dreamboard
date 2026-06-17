import { beforeEach, expect, mock, test } from "bun:test";

mock.restore();

type MockApiResponse<T> = {
  data: T | null;
  error: { message: string } | null;
  response: { status: number };
};

const mockState: {
  compiledResultResponse: MockApiResponse<{
    id: string;
    success: boolean;
  }>;
  latestCompiledResultResponse: MockApiResponse<{ id: string }>;
  listCompiledResultsResponse: MockApiResponse<{
    results: Array<{
      id: string;
      authoringStateId: string;
      revisionDigest?: string;
      success: boolean;
      createdAt?: string;
    }>;
  }>;
  listProjectCompiledResultsResponse: MockApiResponse<{
    results: Array<{
      id: string;
      authoringStateId: string;
      revisionDigest?: string;
      success: boolean;
      createdAt?: string;
    }>;
  }>;
  listCompiledResultsCalls: Array<{
    path: { gameId: string };
    query?: { limit?: number; authoringStateId?: string };
  }>;
  listProjectCompiledResultsCalls: Array<{
    path: { projectId: string };
    query?: { limit?: number };
  }>;
  jobResponses: Array<
    MockApiResponse<{
      jobId: string;
      gameId: string;
      jobType: "COMPILED_RESULT_BUILD";
      status:
        | "PENDING"
        | "RUNNING"
        | "COMPLETED"
        | "FAILED"
        | "CANCELLED"
        | "INTERRUPTED";
      createdAt: string;
      phase?: string;
      message?: string;
      errorMessage?: string;
      createdCompiledResultId?: string;
      createdAppScriptId?: string;
    }>
  >;
} = {
  compiledResultResponse: {
    data: {
      id: "compiled-result-1",
      success: true,
    },
    error: null,
    response: { status: 200 },
  },
  latestCompiledResultResponse: {
    data: {
      id: "compiled-result-1",
    },
    error: null,
    response: { status: 200 },
  },
  listCompiledResultsResponse: {
    data: {
      results: [],
    },
    error: null,
    response: { status: 200 },
  },
  listProjectCompiledResultsResponse: {
    data: {
      results: [],
    },
    error: null,
    response: { status: 200 },
  },
  listCompiledResultsCalls: [],
  listProjectCompiledResultsCalls: [],
  jobResponses: [],
};

mock.module("@dreamboard-games/api-client", () => ({
  getCompiledResult: async () => mockState.compiledResultResponse,
  getProjectCompiledResult: async () => mockState.compiledResultResponse,
  getJob: async () => {
    const nextResponse = mockState.jobResponses.shift();
    if (!nextResponse) {
      throw new Error("No mocked job response available.");
    }
    return nextResponse;
  },
  getLatestCompiledResult: async () => mockState.latestCompiledResultResponse,
  queueProjectRevisionCompile: async () => ({
    data: { jobId: "compile-job-1" },
    error: null,
    response: { status: 200 },
  }),
  listCompiledResults: async (options: {
    path: { gameId: string };
    query?: { limit?: number; authoringStateId?: string };
  }) => {
    mockState.listCompiledResultsCalls.push(options);
    return mockState.listCompiledResultsResponse;
  },
  listProjectCompiledResults: async (options: {
    path: { projectId: string };
    query?: { limit?: number };
  }) => {
    mockState.listProjectCompiledResultsCalls.push(options);
    return mockState.listProjectCompiledResultsResponse;
  },
}));

const {
  findCompiledResultsForAuthoringState,
  findProjectCompiledResultsForRevision,
  waitForCompiledResultJobSdk,
} = await import("./compiled-results-api.ts");

beforeEach(() => {
  mockState.compiledResultResponse = {
    data: {
      id: "compiled-result-1",
      success: true,
    },
    error: null,
    response: { status: 200 },
  };
  mockState.latestCompiledResultResponse = {
    data: {
      id: "compiled-result-1",
    },
    error: null,
    response: { status: 200 },
  };
  mockState.listCompiledResultsResponse = {
    data: {
      results: [],
    },
    error: null,
    response: { status: 200 },
  };
  mockState.listProjectCompiledResultsResponse = {
    data: {
      results: [],
    },
    error: null,
    response: { status: 200 },
  };
  mockState.listCompiledResultsCalls = [];
  mockState.listProjectCompiledResultsCalls = [];
  mockState.jobResponses = [];
});

test("findCompiledResultsForAuthoringState no-ops after game-scoped result list removal", async () => {
  mockState.listCompiledResultsResponse = {
    data: {
      results: [
        {
          id: "compiled-result-2",
          authoringStateId: "authoring-state-2",
          success: true,
        },
      ],
    },
    error: null,
    response: { status: 200 },
  };

  const results = await findCompiledResultsForAuthoringState({
    gameId: "game-1",
    authoringStateId: "authoring-state-2",
  });

  expect(results).toEqual([]);
  expect(mockState.listCompiledResultsCalls).toEqual([]);
});

test("findProjectCompiledResultsForRevision filters project results by revision digest", async () => {
  mockState.listProjectCompiledResultsResponse = {
    data: {
      results: [
        {
          id: "compiled-result-1",
          authoringStateId: "revision-digest-1",
          success: true,
        },
        {
          id: "compiled-result-2",
          authoringStateId: "other",
          revisionDigest: "revision-digest-2",
          success: false,
        },
      ],
    },
    error: null,
    response: { status: 200 },
  };

  const results = await findProjectCompiledResultsForRevision({
    projectId: "project-1",
    revisionDigest: "revision-digest-2",
  });

  expect(results).toEqual([
    {
      id: "compiled-result-2",
      authoringStateId: "other",
      revisionDigest: "revision-digest-2",
      success: false,
    },
  ]);
  expect(mockState.listProjectCompiledResultsCalls).toEqual([
    {
      path: { projectId: "project-1" },
      query: { limit: 100 },
    },
  ]);
});

test("waitForCompiledResultJobSdk surfaces compiler job messages when a failed job never creates a result", async () => {
  mockState.jobResponses.push({
    data: {
      jobId: "job-1",
      gameId: "game-1",
      jobType: "COMPILED_RESULT_BUILD",
      status: "FAILED",
      createdAt: "2026-03-17T05:45:58Z",
      phase: "failed",
      message:
        'Compiler workspace root "/data/compiler-workspaces" requires a mounted /data volume.',
    },
    error: null,
    response: { status: 200 },
  });

  await expect(
    waitForCompiledResultJobSdk({
      gameId: "game-1",
      jobId: "job-1",
    }),
  ).rejects.toThrow(
    'Compile failed [failed]: Compiler workspace root "/data/compiler-workspaces" requires a mounted /data volume.',
  );
});

test("waitForCompiledResultJobSdk falls back to a descriptive terminal error when the job has no detail message", async () => {
  mockState.jobResponses.push({
    data: {
      jobId: "job-2",
      gameId: "game-1",
      jobType: "COMPILED_RESULT_BUILD",
      status: "COMPLETED",
      createdAt: "2026-03-17T05:45:58Z",
      phase: "completed",
    },
    error: null,
    response: { status: 200 },
  });

  await expect(
    waitForCompiledResultJobSdk({
      gameId: "game-1",
      jobId: "job-2",
    }),
  ).rejects.toThrow(
    "Compile completed [completed]: job job-2 ended before a compiled result was created.",
  );
});
