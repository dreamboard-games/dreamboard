import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadProjectConfig } from "../../config/project-config.js";
import { materializeWorkspaceProject } from "./materialize-workspace.js";

const tempDirs: string[] = [];
const blankManifest = {
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
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("materializes revision-native authoring state without tracked authoring ids", async () => {
  const targetDir = await mkdtemp(
    path.join(tmpdir(), "dreamboard-materialize-"),
  );
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
    manifest: blankManifest,
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
  expect(
    await Bun.file(
      path.join(targetDir, "test", "generated", "testing-contract.ts"),
    ).exists(),
  ).toBe(false);

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

test("materializes receipt-backed local package source", async () => {
  const targetDir = await mkdtemp(
    path.join(tmpdir(), "dreamboard-materialize-"),
  );
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
    manifest: blankManifest,
    ruleText: "",
    installDependencies: false,
    maintainerPackageSource: {
      version: 1,
      registryUrl: "http://127.0.0.1:4873",
      snapshotId: "local-20260623T021500Z",
      fingerprint: "sha256:local",
      publishedAt: "2026-06-23T02:15:00.000Z",
      sdkVersion: "0.4.0-local.20260623.1",
      apiClientVersion: "0.3.0-local.20260623.1",
    },
  });

  const packageJson = JSON.parse(
    await readFile(path.join(targetDir, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    pnpm: { overrides: Record<string, string> };
  };
  expect(packageJson.dependencies["@dreamboard-games/sdk"]).toBe(
    "0.4.0-local.20260623.1",
  );
  expect(packageJson.pnpm.overrides["@dreamboard-games/sdk"]).toBe(
    "0.4.0-local.20260623.1",
  );
  expect(packageJson.pnpm.overrides["@dreamboard-games/api-client"]).toBe(
    "0.3.0-local.20260623.1",
  );

  const loaded = await loadProjectConfig(targetDir);
  expect(loaded.localMaintainerRegistry).toMatchObject({
    registryUrl: "http://127.0.0.1:4873",
    snapshotId: "local-20260623T021500Z",
    fingerprint: "sha256:local",
    packages: {
      "@dreamboard-games/api-client": "0.3.0-local.20260623.1",
      "@dreamboard-games/sdk": "0.4.0-local.20260623.1",
    },
  });
});
