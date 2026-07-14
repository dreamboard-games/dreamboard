import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicSkillScriptsArePublishable,
  IGNORED_PUBLIC_SKILL_ENTRY_NAMES,
  resolvePublicSkillRoot,
} from "./public-skill-utils.ts";
import { AUTHORING_RELEASE_SET } from "../src/release/authoring-release-set.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stageRoot = path.join(packageRoot, ".publish", "package");
const sourcePackage = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
) as {
  version: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  description?: string;
  repository?: string | { type?: string; url?: string };
  homepage?: string;
  bugs?: string | { url?: string };
  license?: string;
};

const repositoryUrl =
  typeof sourcePackage.repository === "string"
    ? sourcePackage.repository
    : (sourcePackage.repository?.url ??
      process.env.DREAMBOARD_PUBLIC_REPOSITORY_URL);
const homepageUrl =
  sourcePackage.homepage ?? process.env.DREAMBOARD_PUBLIC_HOMEPAGE;
const bugsUrl =
  typeof sourcePackage.bugs === "string"
    ? sourcePackage.bugs
    : (sourcePackage.bugs?.url ?? process.env.DREAMBOARD_PUBLIC_BUGS_URL);
const packageJson: Record<string, unknown> = {
  name: "@dreamboard-games/cli",
  version: AUTHORING_RELEASE_SET.packages.cli.version,
  description:
    sourcePackage.description ??
    "Design board games with AI and turn ideas into playable digital prototypes.",
  type: "module",
  bin: {
    dreamboard: "dist/index.js",
  },
  exports: {
    ".": "./dist/index.js",
    "./internal": {
      types: "./dist/internal.d.ts",
      default: "./dist/internal.js",
    },
    "./package.json": "./package.json",
  },
  files: ["dist", "README.md", "release", "scaffold", "skills"],
  keywords: sourcePackage.keywords ?? [
    "dreamboard",
    "cli",
    "game-dev",
    "board-game",
    "multiplayer",
  ],
  engines: {
    node: ">=24",
  },
  publishConfig: {
    access: "public",
  },
  dependencies: buildPublishedDependencies(sourcePackage.dependencies ?? {}),
  optionalDependencies: sourcePackage.optionalDependencies,
  license:
    sourcePackage.license ??
    process.env.DREAMBOARD_PUBLIC_LICENSE ??
    "UNLICENSED",
};

function buildPublishedDependencies(
  sourceDependencies: Record<string, string>,
): Record<string, string> {
  const dependencies = { ...sourceDependencies };
  if (dependencies["@dreamboard-games/api-client"]?.startsWith("workspace:")) {
    dependencies["@dreamboard-games/api-client"] =
      AUTHORING_RELEASE_SET.packages.apiClient.version;
  }
  delete dependencies["@dreamboard-games/cli-core"];
  delete dependencies["@dreamboard-games/sdk"];
  return dependencies;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

if (repositoryUrl) {
  packageJson.repository = {
    type: "git",
    url: repositoryUrl,
  };
}

if (homepageUrl) {
  packageJson.homepage = homepageUrl;
}

if (bugsUrl) {
  packageJson.bugs = {
    url: bugsUrl,
  };
}

const publicSkillRoot = await resolvePublicSkillRoot();
await assertPublicSkillScriptsArePublishable(publicSkillRoot);

async function pruneTransientSkillArtifacts(rootDir: string) {
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (IGNORED_PUBLIC_SKILL_ENTRY_NAMES.has(entry.name)) {
      await rm(entryPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await pruneTransientSkillArtifacts(entryPath);
    }
  }
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(path.join(packageRoot, "dist"), path.join(stageRoot, "dist"), {
  recursive: true,
  force: true,
});
await cp(
  path.join(packageRoot, "src", "scaffold", "assets", "static"),
  path.join(stageRoot, "scaffold", "assets", "static"),
  {
    recursive: true,
    force: true,
  },
);
await mkdir(path.join(stageRoot, "release"), { recursive: true });
await writeFile(
  path.join(stageRoot, "release", "authoring-release-set.json"),
  `${JSON.stringify(AUTHORING_RELEASE_SET, null, 2)}\n`,
  "utf8",
);
if (
  await pathExists(
    path.join(
      stageRoot,
      "dist",
      "agent-verifier",
      "agent-workspace-verifier.mjs",
    ),
  )
) {
  (packageJson.exports as Record<string, unknown>)[
    "./agent-workspace-verifier"
  ] = "./dist/agent-verifier/agent-workspace-verifier.mjs";
}
await cp(
  path.join(packageRoot, "README.md"),
  path.join(stageRoot, "README.md"),
  { force: true },
);
await mkdir(path.join(stageRoot, "skills"), { recursive: true });
const stagedSkillRoot = path.join(stageRoot, "skills", "dreamboard");
await cp(publicSkillRoot, stagedSkillRoot, {
  recursive: true,
  force: true,
});
await pruneTransientSkillArtifacts(stagedSkillRoot);
await writeFile(
  path.join(stageRoot, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
  "utf8",
);
