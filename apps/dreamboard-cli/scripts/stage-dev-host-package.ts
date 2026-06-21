import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORING_RELEASE_SET } from "../src/release/authoring-release-set.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const packageRoot = path.join(repoRoot, "packages", "dev-host");
const stageRoot = path.join(packageRoot, ".publish", "package");

const sourcePackage = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
) as {
  version: string;
  description?: string;
  repository?: string | { type?: string; url?: string };
  homepage?: string;
  license?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const releaseDevHostVersion = AUTHORING_RELEASE_SET.packages.devHost.version;
if (
  sourcePackage.version !== releaseDevHostVersion &&
  !releaseDevHostVersion.startsWith(`${sourcePackage.version}-local.`)
) {
  throw new Error("Dev-host package version does not match release set.");
}

const dependencies: Record<string, string> = {
  ...(sourcePackage.dependencies ?? {}),
  "@dreamboard-games/api-client":
    AUTHORING_RELEASE_SET.packages.apiClient.version,
};
delete dependencies["@dreamboard-games/sdk"];

const packageJson = {
  name: AUTHORING_RELEASE_SET.packages.devHost.name,
  version: AUTHORING_RELEASE_SET.packages.devHost.version,
  description: sourcePackage.description,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
    "./package.json": "./package.json",
  },
  files: ["dist", "src"],
  engines: {
    node: ">=24",
  },
  publishConfig: {
    access: "public",
  },
  dependencies,
  peerDependencies: {
    "@dreamboard-games/sdk": AUTHORING_RELEASE_SET.packages.sdk.version,
  },
  repository: sourcePackage.repository,
  homepage: sourcePackage.homepage,
  license: sourcePackage.license,
};

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(path.join(packageRoot, "dist"), path.join(stageRoot, "dist"), {
  recursive: true,
  force: true,
});
await mkdir(path.join(stageRoot, "src", "dev-host"), { recursive: true });
await mkdir(path.join(stageRoot, "dist", "dev-host"), { recursive: true });
for (const asset of [
  "host-main.css",
  "index.html",
  "plugin.html",
  "shared-styles.css",
]) {
  const sourcePath = path.join(packageRoot, "src", "dev-host", asset);
  await cp(
    sourcePath,
    path.join(stageRoot, "src", "dev-host", asset),
    { force: true },
  );
  const content = await readFile(sourcePath, "utf8");
  const publishedContent = content
    .replace('/host-main.tsx"', '/host-main.js"')
    .replace('/plugin-main.ts"', '/plugin-main.js"');
  await writeFile(
    path.join(stageRoot, "dist", "dev-host", asset),
    publishedContent,
    "utf8",
  );
}
await writeFile(
  path.join(stageRoot, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
  "utf8",
);

console.log(`staged ${packageJson.name}@${packageJson.version}`);
