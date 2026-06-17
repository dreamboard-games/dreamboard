import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AUTHORING_RELEASE_SET } from "../src/release/authoring-release-set.ts";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stageRoot = path.join(packageRoot, ".publish", "package");

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

function assertNoPortableDependencyLeaks(
  dependencies: Record<string, string> | undefined,
): void {
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    if (
      range.startsWith("workspace:") ||
      range.startsWith("file:") ||
      range.startsWith("link:")
    ) {
      throw new Error(`${name} uses non-portable dependency range ${range}`);
    }
    if (range.includes("-local.")) {
      throw new Error(`${name} uses local snapshot range ${range}`);
    }
  }
}

const stagedPackage = JSON.parse(
  await readFile(path.join(stageRoot, "package.json"), "utf8"),
) as PackageJson;
const stagedReleaseSet = JSON.parse(
  await readFile(
    path.join(stageRoot, "release", "authoring-release-set.json"),
    "utf8",
  ),
) as typeof AUTHORING_RELEASE_SET;

if (stagedPackage.name !== AUTHORING_RELEASE_SET.packages.cli.name) {
  throw new Error(`Unexpected staged package name ${stagedPackage.name}`);
}
if (stagedPackage.version !== AUTHORING_RELEASE_SET.packages.cli.version) {
  throw new Error(`Unexpected staged package version ${stagedPackage.version}`);
}
if (stagedReleaseSet.releaseSetId !== AUTHORING_RELEASE_SET.releaseSetId) {
  throw new Error("Staged release set does not match generated release set.");
}
if (
  stagedPackage.dependencies?.["@dreamboard-games/api-client"] !==
  AUTHORING_RELEASE_SET.packages.apiClient.version
) {
  throw new Error("Staged API client dependency does not match release set.");
}
if (stagedPackage.dependencies?.["@dreamboard-games/sdk"]) {
  throw new Error("Staged CLI must not depend on @dreamboard-games/sdk.");
}
assertNoPortableDependencyLeaks(stagedPackage.dependencies);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "dreamboard-cli-smoke-"));
try {
  await writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ private: true, packageManager: "pnpm@10.4.1" }, null, 2)}\n`,
    "utf8",
  );
  await execFileAsync("pnpm", ["add", stageRoot], {
    cwd: tempRoot,
    env: {
      ...process.env,
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  });
  await execFileAsync("pnpm", ["exec", "dreamboard", "--help"], {
    cwd: tempRoot,
  });
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("staged CLI install smoke passed");
