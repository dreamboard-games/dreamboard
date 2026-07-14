import { expect, test } from "bun:test";
import type { ProjectConfig } from "../../types.js";
import {
  finalizeProjectPendingAuthoringSync,
  setLatestCompileAttempt,
  setProjectPendingAuthoringSync,
} from "./project-state.js";

const baseProjectConfig: ProjectConfig = {
  schemaVersion: 2,
  projectId: "project-1",
  slug: "project-1",
  deploymentId: "deployment-1",
  ownerScopeId: "owner-1",
};

test("finalizes pending source sync into revision-native authoring state", () => {
  const withPending = setProjectPendingAuthoringSync(baseProjectConfig, {
    phase: "game_revision_created",
    gameRevisionId: "game-revision-1",
    revisionDigest: "revision-digest-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
    manifestContentHash: "manifest-hash-1",
    localManifestContentHash: "local-manifest-hash-1",
  });

  const finalized = finalizeProjectPendingAuthoringSync(withPending);

  expect(finalized.authoring).toEqual({
    gameRevisionId: "game-revision-1",
    revisionDigest: "revision-digest-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
    manifestContentHash: "manifest-hash-1",
    localManifestContentHash: "local-manifest-hash-1",
  });
});

test("records successful compile attempts by revision digest", () => {
  const updated = setLatestCompileAttempt(baseProjectConfig, {
    resultId: "compiled-result-1",
    jobId: "compile-job-1",
    revisionDigest: "revision-digest-1",
    gameRevisionId: "game-revision-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
    status: "successful",
  });

  expect(updated.compile?.latestSuccessful).toEqual({
    resultId: "compiled-result-1",
    revisionDigest: "revision-digest-1",
    gameRevisionId: "game-revision-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
  });
});
