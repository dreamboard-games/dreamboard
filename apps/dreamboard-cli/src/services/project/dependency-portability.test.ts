import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  assertCompilerPortableDependencies,
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

test("compiler portability rejects unsupported @dreamboard dependencies", async () => {
  const projectRoot = await createProject({
    dependencies: {
      "@dreamboard/app-sdk": "0.1.0",
    },
  });

  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow("The @dreamboard/* package namespace is not supported");
});

test("compiler portability rejects unsupported @dreamboard dev dependencies", async () => {
  const projectRoot = await createProject({
    devDependencies: {
      "@dreamboard/ui-sdk": "0.1.0",
    },
  });

  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow("Repin to the public @dreamboard-games/* packages");
});

test("compiler portability rejects retired local snapshots", async () => {
  const projectRoot = await createProject({
    dependencies: {
      "@dreamboard-games/sdk":
        "0.3.0-alpha.1-local.20260614T104617Z.7984c37368ec",
    },
  });

  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow("Local Dreamboard package snapshots are no longer supported");
  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow("Publish a public alpha package");
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
