import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CandidateSet } from "./candidate.ts";
import type { IsolatedRegistry } from "./isolated-registry.ts";
import { spawnFile } from "./process.ts";

export type ScaffoldProof = {
  commandRoot: string;
  projectRoot: string;
  frozenProjectRoot: string;
  assertions: {
    projectManifestCreated: boolean;
    sdkSpecifier: string;
    devHostSpecifier: string;
    packageManager: string;
    releaseSetId: string;
    localRegistryConfigured: boolean;
  };
  installed: {
    sdkVersion: string;
    devHostVersion: string;
    apiClientVersions: string[];
    lockfileIntegrities: Record<string, boolean>;
    lockfileContainsCandidateIntegrities: boolean;
    allCandidateIntegritiesPresent: boolean;
  };
  commandAdapterVersion: string;
};

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

export async function proveScaffoldAndInstall(options: {
  candidateSet: CandidateSet;
  registry: IsolatedRegistry;
  keepTemp: boolean;
}): Promise<ScaffoldProof> {
  const { candidateSet, registry } = options;
  const root = await mkdtemp(
    path.join(tmpdir(), "dreamboard-authoring-compat-"),
  );
  const commandRoot = path.join(root, "command");
  const projectRoot = path.join(root, "candidate-project");
  const frozenProjectRoot = path.join(root, "candidate-project-frozen");
  await mkdir(commandRoot, { recursive: true });
  await writeFile(
    path.join(commandRoot, "package.json"),
    `${JSON.stringify({ name: "authoring-compat-command", private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(commandRoot, ".npmrc"),
    npmrc(registry.url),
    "utf8",
  );

  await spawnFile(
    "pnpm",
    [
      "add",
      "--ignore-scripts",
      "--save-exact",
      `@dreamboard-games/cli@${candidateSet.releaseSet.packages.cli.version}`,
      "--config.shared-workspace-lockfile=false",
    ],
    { cwd: commandRoot },
  );

  await runPackedCliScript(
    commandRoot,
    "scaffold.mjs",
    scaffoldScript({
      projectRoot,
      candidateSet,
      registryUrl: registry.url,
    }),
  );

  const assertions = await assertScaffoldBeforeInstall({
    projectRoot,
    candidateSet,
    registryUrl: registry.url,
  });

  await writeFile(
    path.join(projectRoot, ".npmrc"),
    npmrc(registry.url),
    "utf8",
  );
  await spawnFile(
    "pnpm",
    ["install", "--ignore-scripts", "--config.shared-workspace-lockfile=false"],
    { cwd: projectRoot },
  );

  await copyForFrozenInstall(projectRoot, frozenProjectRoot);
  await writeFile(
    path.join(frozenProjectRoot, ".npmrc"),
    npmrc(registry.url),
    "utf8",
  );
  await spawnFile(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.shared-workspace-lockfile=false",
    ],
    { cwd: frozenProjectRoot },
  );

  await runPackedCliScript(
    commandRoot,
    "codegen.mjs",
    codegenScript(frozenProjectRoot),
  );
  const installed = await inspectInstalledPackages({
    commandRoot,
    projectRoot: frozenProjectRoot,
    candidateSet,
  });

  if (!options.keepTemp) {
    await rm(projectRoot, { recursive: true, force: true });
  }

  return {
    commandRoot,
    projectRoot,
    frozenProjectRoot,
    assertions,
    installed,
    commandAdapterVersion: "packed-cli-internal-materialize-v1",
  };
}

function npmrc(registryUrl: string): string {
  return [
    `@dreamboard-games:registry=${registryUrl}`,
    "registry=https://registry.npmjs.org/",
    "",
  ].join("\n");
}

async function runPackedCliScript(
  commandRoot: string,
  scriptName: string,
  scriptContent: string,
) {
  const scriptPath = path.join(commandRoot, scriptName);
  await writeFile(scriptPath, scriptContent, "utf8");
  await spawnFile("node", [scriptPath], { cwd: commandRoot });
}

function scaffoldScript(options: {
  projectRoot: string;
  candidateSet: CandidateSet;
  registryUrl: string;
}): string {
  const localMaintainerRegistry =
    options.candidateSet.input.channel === "maintainer-local"
      ? {
          registryUrl: options.registryUrl,
          snapshotId: shortHash(options.candidateSet.releaseSet.releaseSetId),
          fingerprint: shortHash(options.candidateSet.releaseSet.releaseSetId),
          publishedAt: "",
          packages: {
            "@dreamboard-games/sdk":
              options.candidateSet.releaseSet.packages.sdk.version,
            "@dreamboard-games/api-client":
              options.candidateSet.releaseSet.packages.apiClient.version,
          },
        }
      : null;
  return `
    import { materializeWorkspaceProject } from "@dreamboard-games/cli/authoring-compatibility-internal";
    await materializeWorkspaceProject({
      targetDir: ${JSON.stringify(options.projectRoot)},
      projectId: "019ed457-0000-7000-8000-000000000003",
      slug: "candidate-project",
      gameId: "019ed457-0000-7000-8000-000000000003",
      deploymentId: "authoring-compat",
      ownerScopeId: "authoring-compat",
      apiBaseUrl: "http://127.0.0.1:9",
      webBaseUrl: "http://127.0.0.1:9",
      manifest: ${JSON.stringify(blankManifest)},
      ruleText: "",
      installDependencies: false,
      localMaintainerRegistry: ${JSON.stringify(localMaintainerRegistry)},
    });
  `;
}

function codegenScript(projectRoot: string): string {
  return `
    import { applyWorkspaceCodegen } from "@dreamboard-games/cli/authoring-compatibility-internal";
    await applyWorkspaceCodegen({
      projectRoot: ${JSON.stringify(projectRoot)},
      manifest: ${JSON.stringify(blankManifest)},
    });
  `;
}

async function assertScaffoldBeforeInstall(options: {
  projectRoot: string;
  candidateSet: CandidateSet;
  registryUrl: string;
}): Promise<ScaffoldProof["assertions"]> {
  const packageJson = JSON.parse(
    await readFile(path.join(options.projectRoot, "package.json"), "utf8"),
  ) as {
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const projectConfig = JSON.parse(
    await readFile(
      path.join(options.projectRoot, ".dreamboard", "project.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const npmrcPath = path.join(options.projectRoot, ".npmrc");
  const npmrcContent = await readFile(npmrcPath, "utf8").catch(() => "");
  const sdkSpecifier = packageJson.dependencies?.["@dreamboard-games/sdk"];
  const devHostSpecifier =
    packageJson.devDependencies?.["@dreamboard-games/dev-host"];

  if (sdkSpecifier !== options.candidateSet.releaseSet.packages.sdk.version) {
    throw new Error("Scaffolded SDK specifier does not match the release set.");
  }
  if (
    devHostSpecifier !==
    options.candidateSet.releaseSet.packages.devHost.version
  ) {
    throw new Error(
      "Scaffolded dev-host specifier does not match the release set.",
    );
  }
  if (
    packageJson.packageManager !==
    options.candidateSet.releaseSet.packageManager
  ) {
    throw new Error(
      "Scaffolded package manager does not match the release set.",
    );
  }
  const dreamboardDeps = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  for (const [name, specifier] of Object.entries(dreamboardDeps)) {
    if (!name.startsWith("@dreamboard-games/")) continue;
    if (
      !["@dreamboard-games/sdk", "@dreamboard-games/dev-host"].includes(name)
    ) {
      throw new Error(
        `Removed Dreamboard leaf package ${name} was scaffolded.`,
      );
    }
    if (
      specifier.startsWith("workspace:") ||
      specifier.startsWith("file:") ||
      specifier.startsWith("link:") ||
      /^[~^*]/.test(specifier)
    ) {
      throw new Error(
        `Mutable Dreamboard package specifier found: ${name}@${specifier}`,
      );
    }
  }

  const localRegistryConfigured = npmrcContent.includes(options.registryUrl);
  if (
    options.candidateSet.input.channel === "public" &&
    localRegistryConfigured
  ) {
    throw new Error("Public scaffold must not configure a local registry.");
  }
  if (
    options.candidateSet.input.channel === "maintainer-local" &&
    !localRegistryConfigured
  ) {
    throw new Error(
      "Maintainer-local scaffold must configure the candidate registry.",
    );
  }

  return {
    projectManifestCreated: projectConfig.schemaVersion === 2,
    sdkSpecifier,
    devHostSpecifier,
    packageManager: packageJson.packageManager ?? "",
    releaseSetId: options.candidateSet.releaseSet.releaseSetId,
    localRegistryConfigured,
  };
}

async function copyForFrozenInstall(sourceRoot: string, targetRoot: string) {
  await rm(targetRoot, { recursive: true, force: true });
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
}

async function inspectInstalledPackages(options: {
  commandRoot: string;
  projectRoot: string;
  candidateSet: CandidateSet;
}): Promise<ScaffoldProof["installed"]> {
  const sdkPackageJson = JSON.parse(
    await readFile(
      path.join(
        options.projectRoot,
        "node_modules",
        "@dreamboard-games",
        "sdk",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string };
  const devHostPackageJson = JSON.parse(
    await readFile(
      path.join(
        options.projectRoot,
        "node_modules",
        "@dreamboard-games",
        "dev-host",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string; dependencies?: Record<string, string> };
  const lockfile = await readFile(
    path.join(options.projectRoot, "pnpm-lock.yaml"),
    "utf8",
  );
  const commandLockfile = await readFile(
    path.join(options.commandRoot, "pnpm-lock.yaml"),
    "utf8",
  );
  const apiClientVersions = [
    ...new Set(
      [...lockfile.matchAll(/@dreamboard-games\/api-client@([^'(:\n]+)/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].filter(Boolean);
  const lockfileIntegrities = Object.fromEntries(
    Object.values(options.candidateSet.packages).map((candidate) => [
      candidate.packageJson.name,
      candidate.key === "cli"
        ? commandLockfile.includes(candidate.integrity)
        : lockfile.includes(candidate.integrity),
    ]),
  );
  const allCandidateIntegritiesPresent =
    Object.values(lockfileIntegrities).every(Boolean);
  return {
    sdkVersion: sdkPackageJson.version,
    devHostVersion: devHostPackageJson.version,
    apiClientVersions,
    lockfileIntegrities,
    lockfileContainsCandidateIntegrities: allCandidateIntegritiesPresent,
    allCandidateIntegritiesPresent,
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
