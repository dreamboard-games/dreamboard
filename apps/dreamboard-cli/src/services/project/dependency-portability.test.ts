import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  assertCompilerPortableDependencies,
  assertReleaseEnvironmentPortableDependencies,
  buildSourceDependencyProfile,
} from "./dependency-portability.js";
import { AUTHORING_RELEASE_SET } from "../../release/authoring-release-set.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("dependency profile tracks public Dreamboard packages only", async () => {
  const projectRoot = await createProject({
    dependencies: {
      dreamboard: "0.1.30-alpha.2",
      "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
      react: "^19.0.0",
    },
  });

  const profile = await buildSourceDependencyProfile({ projectRoot });

  expect(profile.packages).toEqual({
    dreamboard: "0.1.30-alpha.2",
    "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
  });
});

test("compiler portability rejects unsupported @dreamboard package dependencies", async () => {
  const projectRoot = await createProject({
    dependencies: {
      "@dreamboard/app-sdk": "0.1.0",
    },
  });

  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow("The @dreamboard/* package namespace is not supported");
});

test("release portability rejects unsupported @dreamboard package dependencies before release proof", async () => {
  const projectRoot = await createProject({
    devDependencies: {
      "@dreamboard/ui-sdk": "0.1.0",
    },
  });

  await expect(
    assertReleaseEnvironmentPortableDependencies({
      projectRoot,
      environment: "staging",
    }),
  ).rejects.toThrow("Repin to the public @dreamboard-games/* packages");
});

test("release portability ignores stale local snapshot state when packages are public", async () => {
  const projectRoot = await createProject({
    dependencies: {
      "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
    },
  });

  const profile = await assertReleaseEnvironmentPortableDependencies({
    projectRoot,
    environment: "staging",
    projectConfig: {
      schemaVersion: 1,
      localMaintainerRegistry: {
        registryUrl: "http://127.0.0.1:4873",
        snapshotId: "stale",
        fingerprint: "stale",
        publishedAt: "",
        packages: {
          "@dreamboard-games/sdk":
            "0.3.0-alpha.1-local.20260614T104617Z.7984c37368ec",
        },
      },
    },
  });

  expect(profile.dreamboardRegistryUrl).toBeUndefined();
  expect(profile.localSnapshotId).toBeUndefined();
});

async function createProject(packageJson: unknown): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "dreamboard-cli-"));
  tempDirs.push(projectRoot);
  await writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  return projectRoot;
}
