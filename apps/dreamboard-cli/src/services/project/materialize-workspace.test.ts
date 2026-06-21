import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadProjectConfig } from "../../config/project-config.js";
import { materializeWorkspaceProject } from "./materialize-workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("materializes revision-native authoring state without tracked legacy ids", async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), "dreamboard-materialize-"));
  tempDirs.push(targetDir);

  await materializeWorkspaceProject({
    targetDir,
    projectId: "project-1",
    slug: "project-1",
    deploymentId: "deployment-1",
    ownerScopeId: "owner-1",
    bindingKey: "deployment-1:owner-1",
    apiBaseUrl: "https://api.example.com",
    webBaseUrl: "https://web.example.com",
    manifest: {
      players: {
        minPlayers: 2,
        maxPlayers: 4,
        optimalPlayers: 4,
      },
      cardSets: [],
      zones: [],
      boardTemplates: [],
      boards: [],
      pieceTypes: [],
      pieceSeeds: [],
      dieTypes: [],
      dieSeeds: [],
      resources: [],
      setupOptions: [],
      setupProfiles: [],
    },
    ruleText: "",
    gameRevisionId: "game-revision-1",
    revisionDigest: "revision-digest-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
    manifestContentHash: "manifest-hash-1",
    installDependencies: false,
  });

  const projectJson = await readFile(
    path.join(targetDir, ".dreamboard", "project.json"),
    "utf8",
  );
  expect(projectJson).toContain('"projectId": "project-1"');
  expect(projectJson).not.toContain("gameRevisionId");
  expect(projectJson).not.toContain("authoringStateId");
  expect(projectJson).not.toContain("ruleId");
  expect(projectJson).not.toContain("manifestId");

  const loaded = await loadProjectConfig(targetDir);
  expect(loaded.remoteHeadDigest).toBe("revision-digest-1");
  expect(loaded.authoring).toMatchObject({
    gameRevisionId: "game-revision-1",
    revisionDigest: "revision-digest-1",
    sourceRevisionId: "source-revision-1",
    sourceTreeHash: "source-tree-1",
    manifestContentHash: "manifest-hash-1",
  });
});
