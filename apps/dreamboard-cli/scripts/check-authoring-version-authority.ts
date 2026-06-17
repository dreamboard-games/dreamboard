import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORING_RELEASE_SET } from "../src/release/authoring-release-set.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const forbiddenSymbols = [
  "DEFAULT_SDK_DEPENDENCY_RANGES",
  "stripLocalSnapshotSuffix",
  "resolveSdkDependencyRange",
  "@dreamboard-games/sdk/codegen",
] as const;
const currentVersions = new Set(
  Object.values(AUTHORING_RELEASE_SET.packages).map((entry) => entry.version),
);
const allowedVersionFiles = new Set([
  path.join(packageRoot, "src/release/authoring-release-set.generated.ts"),
  path.join(packageRoot, "package.json"),
  path.join(repoRoot, "packages/api-client/package.json"),
  path.join(repoRoot, "pnpm-lock.yaml"),
]);
const selfPath = fileURLToPath(import.meta.url);

async function walk(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (
      entry.isDirectory() &&
      entry.name !== "node_modules" &&
      entry.name !== "dist" &&
      entry.name !== ".publish"
    ) {
      files.push(...(await walk(filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

const files = [
  ...(await walk(path.join(packageRoot, "src"))),
  ...(await walk(path.join(packageRoot, "scripts"))),
].filter((filePath) => /\.(ts|tsx|js|mjs|json)$/.test(filePath));

const failures: string[] = [];
for (const filePath of files) {
  const content = await readFile(filePath, "utf8");
  if (filePath !== selfPath) {
    for (const symbol of forbiddenSymbols) {
      if (content.includes(symbol)) {
        failures.push(`${relative(filePath)} contains forbidden ${symbol}`);
      }
    }
  }
  if (allowedVersionFiles.has(filePath)) {
    continue;
  }
  for (const version of currentVersions) {
    if (content.includes(version)) {
      failures.push(
        `${relative(filePath)} repeats current release version ${version}`,
      );
    }
  }
}

const scaffoldSource = await readFile(
  path.join(packageRoot, "src/services/project/static-scaffold.ts"),
  "utf8",
);
for (const requiredSnippet of [
  "AUTHORING_RELEASE_SET.packages.sdk.version",
  "AUTHORING_RELEASE_SET.packages.devHost.version",
  "AUTHORING_RELEASE_SET.packageManager",
]) {
  if (!scaffoldSource.includes(requiredSnippet)) {
    failures.push(`static scaffold is not derived from ${requiredSnippet}`);
  }
}

const stagedPackageJsonPath = path.join(
  packageRoot,
  ".publish/package/package.json",
);
const stagedDevHostPackageJsonPath = path.join(
  repoRoot,
  "packages/dev-host/.publish/package/package.json",
);

function assertNoPortableDependencyLeaks(
  label: string,
  dependencies: Record<string, string> | undefined,
): void {
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    if (
      range.startsWith("workspace:") ||
      range.startsWith("file:") ||
      range.startsWith("link:")
    ) {
      failures.push(`${label} ${name} uses non-portable dependency range ${range}`);
    }
    if (range.includes("-local.")) {
      failures.push(`${label} ${name} uses local snapshot range ${range}`);
    }
  }
}

try {
  const stagedReleaseSet = JSON.parse(
    await readFile(
      path.join(
        packageRoot,
        ".publish/package/release/authoring-release-set.json",
      ),
      "utf8",
    ),
  ) as {
    releaseSetId?: string;
  };
  if (stagedReleaseSet.releaseSetId !== AUTHORING_RELEASE_SET.releaseSetId) {
    throw new Error("stale staged release set");
  }
  const stagedPackage = JSON.parse(
    await readFile(stagedPackageJsonPath, "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  assertNoPortableDependencyLeaks("staged CLI", stagedPackage.dependencies);
  if (stagedPackage.dependencies?.["@dreamboard-games/sdk"]) {
    failures.push(
      "staged CLI package has a runtime @dreamboard-games/sdk dependency",
    );
  }
} catch (error) {
  if (
    (error as NodeJS.ErrnoException).code !== "ENOENT" &&
    (error as Error).message !== "stale staged release set"
  ) {
    throw error;
  }
}

try {
  const stagedDevHostPackage = JSON.parse(
    await readFile(stagedDevHostPackageJsonPath, "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  assertNoPortableDependencyLeaks(
    "staged dev-host",
    stagedDevHostPackage.dependencies,
  );
  if (
    stagedDevHostPackage.dependencies?.["@dreamboard-games/api-client"] !==
    AUTHORING_RELEASE_SET.packages.apiClient.version
  ) {
    failures.push(
      "staged dev-host API-client dependency does not match release set",
    );
  }
  if (stagedDevHostPackage.dependencies?.["@dreamboard-games/sdk"]) {
    failures.push(
      "staged dev-host package has a runtime @dreamboard-games/sdk dependency",
    );
  }
  if (
    stagedDevHostPackage.peerDependencies?.["@dreamboard-games/sdk"] !==
    AUTHORING_RELEASE_SET.packages.sdk.version
  ) {
    failures.push("staged dev-host SDK peer does not match release set");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

if (failures.length > 0) {
  throw new Error(
    `Authoring version authority check failed:\n- ${failures.join("\n- ")}`,
  );
}

console.log("authoring version authority check passed");
