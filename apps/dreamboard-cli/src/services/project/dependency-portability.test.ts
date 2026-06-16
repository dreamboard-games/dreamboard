import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  assertCompilerPortableDependencies,
  assertReleaseEnvironmentPortableDependencies,
  buildSourceDependencyProfile,
} from "./dependency-portability.js";

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
      "@dreamboard-games/sdk": "0.4.0-alpha.0",
      react: "^19.0.0",
    },
  });

  const profile = await buildSourceDependencyProfile({ projectRoot });

  expect(profile.packages).toEqual({
    dreamboard: "0.1.30-alpha.2",
    "@dreamboard-games/sdk": "0.4.0-alpha.0",
  });
});

test("compiler portability rejects legacy @dreamboard package dependencies", async () => {
  const projectRoot = await createProject({
    dependencies: {
      "@dreamboard/app-sdk": "0.1.0",
    },
  });

  await expect(
    assertCompilerPortableDependencies({ projectRoot }),
  ).rejects.toThrow(
    "Legacy @dreamboard/* package dependencies are no longer supported",
  );
});

test("release portability rejects legacy @dreamboard package dependencies before release proof", async () => {
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
