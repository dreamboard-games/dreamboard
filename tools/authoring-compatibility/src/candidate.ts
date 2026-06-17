import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnFile } from "./process.ts";

export type CandidateKey = "sdk" | "apiClient" | "devHost" | "cli";

export type AuthoringCompatibilityCandidateV1 = {
  sdkTarball: string;
  apiClientTarball: string;
  devHostTarball: string;
  cliTarball: string;
  expectedReleaseSetId?: string;
  channel: "public" | "maintainer-local";
};

export type PackageJson = {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  packageManager?: string;
  exports?: unknown;
  [key: string]: unknown;
};

export type CandidatePackage = {
  key: CandidateKey;
  expectedName: string;
  tarballPath: string;
  tarballName: string;
  unpackedRoot: string;
  packageJson: PackageJson;
  sha512Hex: string;
  integrity: string;
};

export type CandidateSet = {
  input: AuthoringCompatibilityCandidateV1;
  packages: Record<CandidateKey, CandidatePackage>;
  releaseSet: AuthoringReleaseSetLike;
};

export type AuthoringReleaseSetLike = {
  schemaVersion: number;
  releaseSetId: string;
  channel: "public" | "maintainer-local";
  packages: Record<
    CandidateKey,
    {
      name: string;
      version: string;
    }
  >;
  packageManager: string;
  protocols?: Record<string, number>;
  schemas?: Record<string, number>;
  registry?: Record<string, unknown>;
};

const EXPECTED_NAMES: Record<CandidateKey, string> = {
  sdk: "@dreamboard-games/sdk",
  apiClient: "@dreamboard-games/api-client",
  devHost: "@dreamboard-games/dev-host",
  cli: "@dreamboard-games/cli",
};

export async function loadCandidateSet(
  input: AuthoringCompatibilityCandidateV1,
): Promise<CandidateSet> {
  if (process.env.DREAMBOARD_CLI_ENTRY?.trim()) {
    throw new Error(
      "DREAMBOARD_CLI_ENTRY is not allowed for packed authoring compatibility proof.",
    );
  }

  const packages = Object.fromEntries(
    await Promise.all(
      (Object.keys(EXPECTED_NAMES) as CandidateKey[]).map(async (key) => {
        const tarballPath = input[`${key}Tarball` as const];
        return [key, await inspectCandidatePackage(key, tarballPath)];
      }),
    ),
  ) as Record<CandidateKey, CandidatePackage>;
  const releaseSet = await readCliReleaseSet(packages.cli);

  if (
    input.expectedReleaseSetId &&
    input.expectedReleaseSetId !== releaseSet.releaseSetId
  ) {
    throw new Error(
      `CLI release set ${releaseSet.releaseSetId} did not match expected ${input.expectedReleaseSetId}.`,
    );
  }
  if (releaseSet.channel !== input.channel) {
    throw new Error(
      `CLI release set channel ${releaseSet.channel} did not match candidate channel ${input.channel}.`,
    );
  }

  for (const key of Object.keys(packages) as CandidateKey[]) {
    const candidate = packages[key];
    const releasePackage = releaseSet.packages[key];
    if (!releasePackage) {
      throw new Error(`CLI release set does not include ${key}.`);
    }
    if (releasePackage.name !== candidate.packageJson.name) {
      throw new Error(
        `Release set ${key} package name ${releasePackage.name} does not match ${candidate.packageJson.name}.`,
      );
    }
    if (releasePackage.version !== candidate.packageJson.version) {
      throw new Error(
        `Release set ${key} version ${releasePackage.version} does not match candidate ${candidate.packageJson.version}.`,
      );
    }
  }

  assertPackageDependenciesMatchReleaseSet(packages, releaseSet);
  assertProvenance(input, releaseSet);

  return { input, packages, releaseSet };
}

async function inspectCandidatePackage(
  key: CandidateKey,
  tarballPathInput: string,
): Promise<CandidatePackage> {
  if (!tarballPathInput?.trim()) {
    throw new Error(`Missing ${key} tarball.`);
  }
  const tarballPath = path.resolve(tarballPathInput);
  const fileStat = await stat(tarballPath).catch((error: unknown) => {
    throw new Error(`Cannot read ${key} tarball at ${tarballPath}.`, {
      cause: error,
    });
  });
  if (!fileStat.isFile() || !tarballPath.endsWith(".tgz")) {
    throw new Error(`${key} candidate must be an immutable .tgz tarball.`);
  }

  const unpackRoot = await mkdtemp(
    path.join(tmpdir(), `dreamboard-authoring-${key}-`),
  );
  await spawnFile("tar", ["-xzf", tarballPath, "-C", unpackRoot]);
  const unpackedRoot = path.join(unpackRoot, "package");
  const packageJson = JSON.parse(
    await readFile(path.join(unpackedRoot, "package.json"), "utf8"),
  ) as PackageJson;
  const expectedName = EXPECTED_NAMES[key];
  if (packageJson.name !== expectedName) {
    throw new Error(
      `${key} tarball declares ${packageJson.name}; expected ${expectedName}.`,
    );
  }
  if (!isExactVersion(packageJson.version)) {
    throw new Error(`${expectedName} candidate version must be exact.`);
  }
  const bytes = await readFile(tarballPath);
  const sha512Hex = createHash("sha512").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return {
    key,
    expectedName,
    tarballPath,
    tarballName: path.basename(tarballPath),
    unpackedRoot,
    packageJson,
    sha512Hex,
    integrity,
  };
}

async function readCliReleaseSet(
  cliPackage: CandidatePackage,
): Promise<AuthoringReleaseSetLike> {
  return JSON.parse(
    await readFile(
      path.join(
        cliPackage.unpackedRoot,
        "release",
        "authoring-release-set.json",
      ),
      "utf8",
    ),
  ) as AuthoringReleaseSetLike;
}

function assertPackageDependenciesMatchReleaseSet(
  packages: Record<CandidateKey, CandidatePackage>,
  releaseSet: AuthoringReleaseSetLike,
) {
  const cliApiClient =
    packages.cli.packageJson.dependencies?.["@dreamboard-games/api-client"];
  if (cliApiClient !== releaseSet.packages.apiClient.version) {
    throw new Error(
      "CLI API-client dependency does not match the release set.",
    );
  }
  if (packages.cli.packageJson.dependencies?.["@dreamboard-games/sdk"]) {
    throw new Error("Packed CLI must not have a runtime SDK dependency.");
  }

  const devHostApiClient =
    packages.devHost.packageJson.dependencies?.["@dreamboard-games/api-client"];
  if (devHostApiClient !== releaseSet.packages.apiClient.version) {
    throw new Error(
      "Dev-host API-client dependency does not match the release set.",
    );
  }
  if (packages.devHost.packageJson.dependencies?.["@dreamboard-games/sdk"]) {
    throw new Error("Packed dev-host must not have a runtime SDK dependency.");
  }
  const devHostSdkPeer =
    packages.devHost.packageJson.peerDependencies?.["@dreamboard-games/sdk"];
  if (devHostSdkPeer !== releaseSet.packages.sdk.version) {
    throw new Error(
      "Dev-host SDK peer dependency does not match the release set.",
    );
  }
}

function assertProvenance(
  input: AuthoringCompatibilityCandidateV1,
  releaseSet: AuthoringReleaseSetLike,
) {
  const versions = Object.values(releaseSet.packages).map(
    (entry) => `${entry.name}@${entry.version}`,
  );
  if (input.channel === "public") {
    const localVersion = versions.find((entry) => entry.includes("-local."));
    if (localVersion) {
      throw new Error(
        `Public channel cannot contain local version ${localVersion}.`,
      );
    }
    if (
      releaseSet.registry?.kind &&
      releaseSet.registry.kind !== "public-npm"
    ) {
      throw new Error(
        "Public channel release set must use public-npm registry.",
      );
    }
    return;
  }

  if (releaseSet.registry?.kind !== "maintainer-local") {
    throw new Error(
      "Maintainer-local channel requires maintainer-local registry metadata.",
    );
  }
}

function isExactVersion(version: unknown): version is string {
  return (
    typeof version === "string" &&
    version.trim().length > 0 &&
    !version.startsWith("workspace:") &&
    !version.startsWith("file:") &&
    !version.startsWith("link:") &&
    !/^[~^*]/.test(version)
  );
}
