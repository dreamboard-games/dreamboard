import { beforeEach, expect, test } from "bun:test";
import {
  authoringCommandTestHarness,
  resetAuthoringCommandTestHarness,
} from "../test-support/authoring-command-test-harness.ts";

const syncCommand = (await import("./sync.ts")).default;

function currentState() {
  return authoringCommandTestHarness.current;
}

beforeEach(() => {
  resetAuthoringCommandTestHarness();
});

test("sync uploads authored changes and advances authoring state without compiling", async () => {
  const state = currentState();
  state.getLocalDiffResult = {
    modified: ["app/phases/setup.ts"],
    added: [],
    deleted: [],
  };
  state.collectLocalFilesResult = {
    "app/phases/setup.ts": "export const updatedPhase = true;\n",
  };
  state.getAuthoringHeadSdkResult = {
    ...state.getAuthoringHeadSdkResult!,
    authoringStateId: "authoring-1",
    sourceRevisionId: "source-revision-1",
    treeHash: "tree-hash-1",
  };
  state.createSourceRevisionResult = {
    id: "source-revision-2",
    treeHash: "tree-hash-2",
  };
  state.createAuthoringStateResult = {
    ...state.createAuthoringStateResult,
    authoringStateId: "authoring-2",
    sourceRevisionId: "source-revision-2",
    treeHash: "tree-hash-2",
    sourceTreeHash: "tree-hash-2",
    manifestId: "manifest-1",
    manifestContentHash: "content-hash-1",
    ruleId: "rule-1",
  };

  await syncCommand.run({
    args: {
      env: "local",
      force: false,
      "update-sdk": false,
      yes: false,
    },
  });

  expect(state.calls.uploadProjectSourceBlobsSdk).toHaveLength(1);
  expect(state.calls.uploadProjectSourceBlobsSdk[0]?.projectId).toBe(
    "project-1",
  );
  expect(state.calls.createGameRevisionSdk).toHaveLength(1);
  expect(state.calls.createGameRevisionSdk[0]).toMatchObject({
    projectId: "project-1",
    request: {
      baseRevisionDigest: "revision-digest-1",
      source: {
        files: [
          {
            path: "app/phases/setup.ts",
          },
        ],
      },
      ruleText: "rule text",
    },
  });
  expect(state.calls.createSourceRevisionSdk).toHaveLength(0);
  expect(state.calls.createAuthoringStateSdk).toHaveLength(0);
  expect(state.calls.queueCompiledResultJobSdk).toHaveLength(0);
  expect(state.projectConfig.authoring).toMatchObject({
    authoringStateId: "authoring-1",
    revisionDigest: "revision-digest-2",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "tree-hash-2",
    manifestId: "manifest-1",
    manifestContentHash: "content-hash-2",
    ruleId: "rule-1",
  });
  expect(state.projectConfig.remoteHeadDigest).toBe("revision-digest-2");
});

test("sync creates the first authored state even when a new workspace has no local diff yet", async () => {
  const state = currentState();
  state.projectConfig.authoring = {};
  state.projectConfig.compile = {};
  state.projectConfig.remoteHeadDigest = undefined;
  state.remoteProjectRevisionDigest = null;
  state.getAuthoringHeadSdkResult = null;
  state.getLocalDiffResult = {
    modified: [],
    added: [],
    deleted: [],
  };
  state.createAuthoringStateResult = {
    ...state.createAuthoringStateResult,
    authoringStateId: "authoring-1",
    sourceRevisionId: "source-revision-2",
    treeHash: "tree-hash-2",
    sourceTreeHash: "tree-hash-2",
    manifestId: "manifest-2",
    manifestContentHash: "content-hash-2",
    ruleId: "rule-1",
  };

  await syncCommand.run({
    args: {
      env: "local",
      force: false,
      "update-sdk": false,
      yes: false,
    },
  });

  expect(state.calls.uploadProjectSourceBlobsSdk).toHaveLength(1);
  expect(state.calls.createGameRevisionSdk).toHaveLength(1);
  expect(state.calls.createGameRevisionSdk[0]).toMatchObject({
    projectId: "project-1",
    request: {
      source: {
        files: [
          {
            path: "app/phases/setup.ts",
          },
        ],
      },
      ruleText: "rule text",
    },
  });
  expect(
    state.calls.createGameRevisionSdk[0]?.request,
  ).not.toHaveProperty("baseRevisionDigest");
  expect(state.calls.createSourceRevisionSdk).toHaveLength(0);
  expect(state.calls.createAuthoringStateSdk).toHaveLength(0);
  expect(
    state.consoleCalls.some(
      (call) =>
        call.level === "info" &&
        call.args.includes("No local authored changes to sync."),
    ),
  ).toBe(false);
  expect(state.projectConfig.authoring).toMatchObject({
    revisionDigest: "revision-digest-2",
    sourceTreeHash: "tree-hash-2",
    manifestContentHash: "content-hash-2",
  });
  expect(state.projectConfig.remoteHeadDigest).toBe("revision-digest-2");
});
