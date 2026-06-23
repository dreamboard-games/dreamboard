import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies";
type PackageKey = "sdk" | "apiClient" | "devHost" | "cli";
type NpmTag = "alpha" | "latest";
type Target =
  | { kind: "version"; version: string }
  | { kind: "tag"; tag: NpmTag; expectation?: "alpha" | "stable" };

type UpdateTarget =
  | {
      kind: "dependency";
      filePath: string;
      section: DependencySection;
      dependencyName: string;
    }
  | {
      kind: "packageVersion";
      filePath: string;
    };

type PackageConfig = {
  key: PackageKey;
  aliases: string[];
  displayName: string;
  npmName: string;
  updates: UpdateTarget[];
};

type Options = {
  packageKey: PackageKey;
  target: Target;
  dryRun: boolean;
  skipVerify: boolean;
};

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const packageConfigs: PackageConfig[] = [
  {
    key: "sdk",
    aliases: ["sdk", "@dreamboard-games/sdk"],
    displayName: "SDK",
    npmName: "@dreamboard-games/sdk",
    updates: [
      dependencyTarget(
        "apps/dreamboard-cli/package.json",
        "devDependencies",
        "@dreamboard-games/sdk",
      ),
      dependencyTarget(
        "packages/dev-host/package.json",
        "dependencies",
        "@dreamboard-games/sdk",
      ),
      dependencyTarget(
        "packages/dev-host/package.json",
        "peerDependencies",
        "@dreamboard-games/sdk",
      ),
    ],
  },
  {
    key: "apiClient",
    aliases: ["api-client", "apiClient", "@dreamboard-games/api-client"],
    displayName: "API client",
    npmName: "@dreamboard-games/api-client",
    updates: [packageVersionTarget("packages/api-client/package.json")],
  },
  {
    key: "devHost",
    aliases: ["dev-host", "devHost", "@dreamboard-games/dev-host"],
    displayName: "dev-host",
    npmName: "@dreamboard-games/dev-host",
    updates: [packageVersionTarget("packages/dev-host/package.json")],
  },
  {
    key: "cli",
    aliases: ["cli", "dreamboard-cli", "@dreamboard-games/cli"],
    displayName: "CLI",
    npmName: "@dreamboard-games/cli",
    updates: [packageVersionTarget("apps/dreamboard-cli/package.json")],
  },
];

const aliases = new Map<string, PackageConfig>();
for (const config of packageConfigs) {
  for (const alias of config.aliases) {
    aliases.set(alias.toLowerCase(), config);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = packageConfigs.find(
    (entry) => entry.key === options.packageKey,
  );
  if (!config) {
    throw new Error(`Unsupported package ${options.packageKey}.`);
  }

  const version =
    options.target.kind === "version"
      ? options.target.version
      : await resolveNpmTag(config.npmName, options.target.tag);

  validateExactVersion(version);
  validateTargetExpectation(config.npmName, version, options.target);
  const changes = await applyUpdates(config, version, options.dryRun);

  const targetLabel =
    options.target.kind === "tag"
      ? `${options.target.tag} (${version})`
      : version;
  const prefix = options.dryRun ? "Would bump" : "Bumped";
  console.log(`${prefix} ${config.npmName} to ${targetLabel}`);
  for (const change of changes) {
    console.log(`- ${change}`);
  }

  if (options.dryRun) {
    console.log("Dry run only. No files were changed.");
    return;
  }

  if (options.skipVerify) {
    console.log("Skipped verification because --skip-verify was provided.");
    return;
  }

  await run("pnpm", ["install", "--lockfile-only"]);
  await run("pnpm", [
    "--dir",
    "apps/dreamboard-cli",
    "run",
    "release-set:generate",
  ]);
  await run("pnpm", ["--dir", "packages/dev-host", "run", "stage:publish"]);
  await run("pnpm", [
    "--dir",
    "apps/dreamboard-cli",
    "run",
    "check:authoring-release-set-npm-freshness",
  ]);
  await run("pnpm", [
    "--dir",
    "apps/dreamboard-cli",
    "run",
    "check:authoring-version-authority",
  ]);
}

function dependencyTarget(
  relativePath: string,
  section: DependencySection,
  dependencyName: string,
): UpdateTarget {
  return {
    kind: "dependency",
    filePath: path.join(repoRoot, relativePath),
    section,
    dependencyName,
  };
}

function packageVersionTarget(relativePath: string): UpdateTarget {
  return {
    kind: "packageVersion",
    filePath: path.join(repoRoot, relativePath),
  };
}

function parseArgs(args: string[]): Options {
  const positional: string[] = [];
  const targets: Target[] = [];
  let dryRun = false;
  let skipVerify = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-verify") {
      skipVerify = true;
      continue;
    }
    if (arg === "--latest-alpha") {
      targets.push({ kind: "tag", tag: "alpha", expectation: "alpha" });
      continue;
    }
    if (arg === "--latest-stable") {
      targets.push({ kind: "tag", tag: "latest", expectation: "stable" });
      continue;
    }
    if (arg === "--tag") {
      const tag = args[index + 1];
      if (tag !== "alpha" && tag !== "latest") {
        throw new Error("--tag must be followed by alpha or latest.");
      }
      targets.push({ kind: "tag", tag });
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    }
    positional.push(arg);
  }

  const packageName = positional[0];
  if (!packageName) {
    throw new Error(usage());
  }

  const config = aliases.get(packageName.toLowerCase());
  if (!config) {
    throw new Error(
      `Unsupported package ${packageName}. Supported packages: ${packageConfigs
        .map((entry) => entry.aliases[0])
        .join(", ")}.`,
    );
  }

  if (positional.length > 2) {
    throw new Error(`Unexpected arguments: ${positional.slice(2).join(" ")}.`);
  }
  if (positional[1]) {
    targets.push({ kind: "version", version: positional[1] });
  }
  if (targets.length !== 1) {
    throw new Error(
      "Pass exactly one target: an exact version, --latest-alpha, --latest-stable, or --tag <alpha|latest>.",
    );
  }

  return {
    packageKey: config.key,
    target: targets[0],
    dryRun,
    skipVerify,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm bump <package> <version> [--dry-run] [--skip-verify]",
    "  pnpm bump <package> --latest-alpha [--dry-run] [--skip-verify]",
    "  pnpm bump <package> --latest-stable [--dry-run] [--skip-verify]",
    "  pnpm bump <package> --tag <alpha|latest> [--dry-run] [--skip-verify]",
    "",
    "Packages: sdk, api-client, dev-host, cli",
  ].join("\n");
}

async function resolveNpmTag(
  packageName: string,
  tag: NpmTag,
): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
  );
  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for ${packageName}.`,
    );
  }
  const packument = (await response.json()) as {
    "dist-tags"?: Record<string, string | undefined>;
  };
  const version = packument["dist-tags"]?.[tag];
  if (!version) {
    throw new Error(`${packageName} does not have an npm ${tag} dist-tag.`);
  }
  return version;
}

async function applyUpdates(
  config: PackageConfig,
  version: string,
  dryRun: boolean,
): Promise<string[]> {
  const grouped = new Map<string, UpdateTarget[]>();
  for (const update of config.updates) {
    const entries = grouped.get(update.filePath) ?? [];
    entries.push(update);
    grouped.set(update.filePath, entries);
  }

  const changes: string[] = [];
  for (const [filePath, updates] of grouped) {
    const packageJson = await readPackageJson(filePath);
    for (const update of updates) {
      if (update.kind === "packageVersion") {
        const previous = packageJson.version;
        if (!previous) {
          throw new Error(`${relative(filePath)} does not have a version.`);
        }
        packageJson.version = version;
        changes.push(
          `${relative(filePath)} version: ${previous} -> ${version}`,
        );
        continue;
      }

      const dependencies = packageJson[update.section];
      const previous = dependencies?.[update.dependencyName];
      if (!dependencies || !previous) {
        throw new Error(
          `${relative(filePath)} ${update.section}.${update.dependencyName} is missing.`,
        );
      }
      dependencies[update.dependencyName] = version;
      changes.push(
        `${relative(filePath)} ${update.section}.${update.dependencyName}: ${previous} -> ${version}`,
      );
    }
    if (!dryRun) {
      await writeFile(
        filePath,
        `${JSON.stringify(packageJson, null, 2)}\n`,
        "utf8",
      );
    }
  }

  return changes;
}

async function readPackageJson(filePath: string): Promise<PackageJson> {
  return JSON.parse(await readFile(filePath, "utf8")) as PackageJson;
}

function validateExactVersion(version: string): void {
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(`${version} is not an exact semver version.`);
  }
}

function validateTargetExpectation(
  packageName: string,
  version: string,
  target: Target,
): void {
  if (target.kind !== "tag" || !target.expectation) {
    return;
  }
  const isPrerelease = version.includes("-");
  const isAlpha = /-alpha(?:\.|$)/.test(version);
  if (target.expectation === "stable" && isPrerelease) {
    throw new Error(
      `${packageName} npm latest resolved to prerelease ${version}; refusing --latest-stable. Use --tag latest to accept the raw dist-tag.`,
    );
  }
  if (target.expectation === "alpha" && !isAlpha) {
    throw new Error(
      `${packageName} npm alpha resolved to ${version}, which is not an alpha version.`,
    );
  }
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

async function run(command: string, args: string[]): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}.`,
          ),
        );
      }
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
