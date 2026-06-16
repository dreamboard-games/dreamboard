import { beforeEach, expect, test } from "bun:test";
import {
  authoringCommandTestHarness,
  resetAuthoringCommandTestHarness,
} from "../test-support/authoring-command-test-harness.ts";

const compileCommand = (await import("./compile.ts")).default;

function currentState() {
  return authoringCommandTestHarness.current;
}

beforeEach(() => {
  resetAuthoringCommandTestHarness();
});

test("compile success updates latest attempt and latest successful state", async () => {
  const state = currentState();
  state.getLocalDiffResult = {
    modified: [],
    added: [],
    deleted: [],
  };
  state.findCompiledResultsForAuthoringStateResult = [];
  state.createCompiledResultResult = {
    id: "result-2",
    authoringStateId: "authoring-1",
    success: true,
    sourceRevisionId: "source-revision-1",
  };

  await compileCommand.run({
    args: {
      env: "local",
    },
  });

  expect(state.calls.queueCompiledResultJobSdk).toEqual([
    {
      projectId: "project-1",
      revisionDigest: "revision-digest-1",
    },
  ]);
  expect(state.projectConfig.compile?.latestAttempt).toEqual({
    resultId: "result-2",
    jobId: "compile-job-1",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
    status: "successful",
    diagnosticsSummary: undefined,
  });
  expect(state.projectConfig.compile?.latestSuccessful).toEqual({
    resultId: "result-2",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
  });
});

test("compile failure persists the failed attempt without changing authored sync", async () => {
  const state = currentState();
  state.getLocalDiffResult = {
    modified: [],
    added: [],
    deleted: [],
  };
  state.findCompiledResultsForAuthoringStateResult = [];
  state.createCompiledResultResult = {
    id: "result-failed",
    authoringStateId: "authoring-1",
    success: false,
    sourceRevisionId: "source-revision-1",
    diagnostics: [
      {
        type: "general",
        category: "typescript",
        message: "Broken import",
      },
    ],
  };

  await expect(
    compileCommand.run({
      args: {
        env: "local",
      },
    }),
  ).rejects.toThrow(
    "Remote compile failed, but your authored state is synced. Fix the diagnostics and run 'dreamboard compile' again.",
  );

  expect(state.projectConfig.authoring?.authoringStateId).toBe("authoring-1");
  expect(state.projectConfig.compile?.latestAttempt).toEqual({
    resultId: "result-failed",
    jobId: "compile-job-1",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
    status: "failed",
    diagnosticsSummary: "Broken import",
  });
  expect(state.projectConfig.compile?.latestSuccessful).toEqual({
    resultId: "result-1",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
  });
});

test("compile persists a failed attempt when the queued job errors before producing a result", async () => {
  const state = currentState();
  state.getLocalDiffResult = {
    modified: [],
    added: [],
    deleted: [],
  };
  state.findCompiledResultsForAuthoringStateResult = [];
  state.waitForCompiledResultJobError = new Error(
    "Failed to get job (HTTP 500)",
  );

  await expect(
    compileCommand.run({
      args: {
        env: "local",
      },
    }),
  ).rejects.toThrow(
    "Remote compile job compile-job-1 could not be completed. Failed to get job (HTTP 500) Check backend health and try 'dreamboard compile' again.",
  );

  expect(state.projectConfig.compile?.latestAttempt).toEqual({
    resultId: undefined,
    jobId: "compile-job-1",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
    status: "failed",
    diagnosticsSummary: "Failed to get job (HTTP 500)",
  });
  expect(state.projectConfig.compile?.latestSuccessful).toEqual({
    resultId: "result-1",
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
  });
});
