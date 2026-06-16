import { beforeEach, expect, test } from "bun:test";
import {
  authoringCommandTestHarness,
  resetAuthoringCommandTestHarness,
} from "../test-support/authoring-command-test-harness.ts";

const statusCommand = (await import("./status.ts")).default;

function currentState() {
  return authoringCommandTestHarness.current;
}

beforeEach(() => {
  resetAuthoringCommandTestHarness();
});

function consoleMessages(level: "info" | "warn") {
  return currentState()
    .consoleCalls.filter((call) => call.level === level)
    .map((call) => call.args.map(String).join(" "));
}

test("status reports authored sync and failed compile separately", async () => {
  const state = currentState();
  state.getLocalDiffResult = {
    modified: [],
    added: [],
    deleted: [],
  };
  state.findCompiledResultsForAuthoringStateResult = [
    {
      id: "result-failed",
      authoringStateId: "authoring-1",
      success: false,
      sourceRevisionId: "source-revision-1",
    },
  ];

  await statusCommand.run({
    args: {
      env: "local",
    },
  });

  expect(consoleMessages("info")).toContain(
    "Project revision: in_sync (local=revision-digest-1, remote=revision-digest-1)",
  );
  expect(consoleMessages("info")).toContain("Compile state: failed");
  expect(consoleMessages("warn")).toContain(
    "Latest compile for the current authored state failed. Fix diagnostics and run 'dreamboard compile' again.",
  );
  expect(consoleMessages("warn")).not.toContain(
    "Remote authored changes are available. Run 'dreamboard pull' to reconcile them into this workspace.",
  );
});

test("status warns when remote authored state is ahead", async () => {
  const state = currentState();
  state.projectConfig.authoring = {
    ...state.projectConfig.authoring,
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
  };
  state.remoteProjectRevisionDigest = "revision-digest-2";
  state.findCompiledResultsForAuthoringStateResult = [
    {
      id: "result-2",
      authoringStateId: "authoring-2",
      success: true,
      sourceRevisionId: "source-revision-2",
    },
  ];

  await statusCommand.run({
    args: {
      env: "local",
    },
  });

  expect(consoleMessages("info")).toContain(
    "Project revision: behind (local=revision-digest-1, remote=revision-digest-2)",
  );
  expect(consoleMessages("warn")).toContain(
    "Remote authored changes are available. Run 'dreamboard pull' to reconcile them into this workspace.",
  );
});

test("status prefers the latest attempt when a newer compile failed", async () => {
  const state = currentState();
  state.findCompiledResultsForAuthoringStateResult = [
    {
      id: "result-failed",
      authoringStateId: "authoring-1",
      success: false,
      sourceRevisionId: "source-revision-1",
    },
    {
      id: "result-success",
      authoringStateId: "authoring-1",
      success: true,
      sourceRevisionId: "source-revision-1",
    },
  ];

  await statusCommand.run({
    args: {
      env: "local",
    },
  });

  expect(consoleMessages("info")).toContain("Compile state: failed");
  expect(consoleMessages("info")).not.toContain("Compile state: successful");
  expect(consoleMessages("warn")).toContain(
    "Latest compile for the current authored state failed. Fix diagnostics and run 'dreamboard compile' again.",
  );
});

test("status reports stale successful compile when authoring moved", async () => {
  const state = currentState();
  state.projectConfig.authoring = {
    ...state.projectConfig.authoring,
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-1",
  };
  state.projectConfig.compile = {
    latestSuccessful: {
      resultId: "result-1",
      authoringStateId: "authoring-1",
      revisionDigest: "revision-digest-1",
    },
  };
  state.remoteProjectRevisionDigest = "revision-digest-2";
  state.findCompiledResultsForAuthoringStateResult = [];

  await statusCommand.run({
    args: {
      env: "local",
    },
  });

  expect(consoleMessages("info")).toContain("Compile state: stale_success");
});

test("status reports that remote state is unavailable when there is no auth token", async () => {
  const state = currentState();
  state.config = {
    ...state.config,
    environment: "prod",
    authToken: undefined,
  };

  await statusCommand.run({
    args: {
      env: "local",
    },
  });

  expect(state.calls.configureClient).toHaveLength(0);
  expect(consoleMessages("warn")).toContain(
    "Remote status unavailable (no auth token).",
  );
});
