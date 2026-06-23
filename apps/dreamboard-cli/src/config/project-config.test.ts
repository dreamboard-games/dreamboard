import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadProjectConfig, updateProjectState } from "./project-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("project config normalization", () => {
  test("writes and reads revision-native authoring state", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "dreamboard-config-"));
    tempDirs.push(rootDir);

    await updateProjectState(rootDir, {
      schemaVersion: 2,
      projectId: "project-1",
      deploymentId: "deployment-1",
      ownerScopeId: "owner-scope-1",
      bindingKey: "deployment-1:owner-scope-1",
      slug: "sample-game",
      authoring: {
        gameRevisionId: "game-revision-1",
        revisionDigest: "revision-digest-1",
        sourceRevisionId: "source-1",
        sourceTreeHash: "tree-1",
        manifestContentHash: "manifest-hash-1",
      },
      compile: {
        latestAttempt: {
          resultId: "result-1",
          revisionDigest: "revision-digest-1",
          gameRevisionId: "game-revision-1",
          status: "failed",
          diagnosticsSummary: "Broken import",
        },
      },
    });

    const loaded = await loadProjectConfig(rootDir);
    expect(loaded.authoring?.gameRevisionId).toBe("game-revision-1");
    expect(loaded.authoring?.revisionDigest).toBe("revision-digest-1");
    expect(loaded.compile?.latestAttempt?.status).toBe("failed");
    expect(loaded.resultId).toBeUndefined();
  });

  test("writes and reads failed compile attempts without a compiled result id", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "dreamboard-config-"));
    tempDirs.push(rootDir);

    await updateProjectState(rootDir, {
      schemaVersion: 2,
      projectId: "project-1",
      deploymentId: "deployment-1",
      ownerScopeId: "owner-scope-1",
      bindingKey: "deployment-1:owner-scope-1",
      slug: "sample-game",
      authoring: {
        revisionDigest: "revision-digest-1",
      },
      compile: {
        latestAttempt: {
          jobId: "compile-job-1",
          revisionDigest: "revision-digest-1",
          status: "failed",
          diagnosticsSummary: "Failed to get job (HTTP 500)",
        },
      },
    });

    const loaded = await loadProjectConfig(rootDir);
    expect(loaded.compile?.latestAttempt?.resultId).toBeUndefined();
    expect(loaded.compile?.latestAttempt?.jobId).toBe("compile-job-1");
    expect(loaded.compile?.latestSuccessful).toBeUndefined();
  });

  test("loads v2 manifest with environment binding state", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "dreamboard-config-"));
    tempDirs.push(rootDir);
    const configDir = path.join(rootDir, ".dreamboard");
    await mkdir(configDir, { recursive: true });

    await writeFile(
      path.join(configDir, "project.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          projectId: "project-1",
          slug: "bound-game",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(configDir, "state.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          bindings: {
            "deployment-1:owner-scope-1": {
              deploymentId: "deployment-1",
              ownerScopeId: "owner-scope-1",
              remoteHeadDigest: "revision-digest-1",
              authoring: {
                revisionDigest: "revision-digest-1",
                gameRevisionId: "game-revision-1",
                sourceRevisionId: "source-revision-1",
                sourceTreeHash: "source-tree-1",
              },
              compile: {
                latestSuccessful: {
                  resultId: "result-1",
                  revisionDigest: "revision-digest-1",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const loaded = await loadProjectConfig(rootDir);
    expect(loaded.projectId).toBe("project-1");
    expect(loaded.bindingKey).toBe("deployment-1:owner-scope-1");
    expect(loaded.remoteHeadDigest).toBe("revision-digest-1");
    expect(loaded.authoring?.gameRevisionId).toBe("game-revision-1");
    expect(loaded.authoring?.sourceRevisionId).toBe("source-revision-1");
    expect(loaded.compile?.latestSuccessful?.resultId).toBe("result-1");
  });

  test("rejects v2 manifest without environment binding state", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "dreamboard-config-"));
    tempDirs.push(rootDir);
    const configDir = path.join(rootDir, ".dreamboard");
    await mkdir(configDir, { recursive: true });

    await writeFile(
      path.join(configDir, "project.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          projectId: "project-1",
          slug: "bound-game",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(loadProjectConfig(rootDir)).rejects.toThrow(
      /missing an environment binding/,
    );
  });

  test("rejects schema v1 before writing state", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "dreamboard-config-"));
    tempDirs.push(rootDir);
    const configDir = path.join(rootDir, ".dreamboard");
    const projectJsonPath = path.join(configDir, "project.json");
    const stateJsonPath = path.join(configDir, "state.json");
    await mkdir(configDir, { recursive: true });
    const originalJson = `${JSON.stringify(
      {
        schemaVersion: 1,
        gameId: "schema-v1-game-1",
        slug: "schema-v1-game",
      },
      null,
      2,
    )}\n`;
    await writeFile(projectJsonPath, originalJson, "utf8");

    await expect(loadProjectConfig(rootDir)).rejects.toThrow(
      /Expected schemaVersion 2/,
    );
    await expect(readFile(projectJsonPath, "utf8")).resolves.toBe(originalJson);
    await expect(stat(stateJsonPath)).rejects.toThrow();
  });
});
