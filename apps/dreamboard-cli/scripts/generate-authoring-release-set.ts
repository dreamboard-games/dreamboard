import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthoringReleaseSetV1 } from "../src/release/authoring-release-set.ts";

type PackageJson = {
  name?: string;
  version?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type PackageKey = "sdk" | "apiClient" | "devHost";

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const outputPath = path.join(
  packageRoot,
  "src",
  "release",
  "authoring-release-set.generated.ts",
);

async function readPackageJson(filePath: string): Promise<PackageJson> {
  return JSON.parse(await readFile(filePath, "utf8")) as PackageJson;
}

function requireExactVersion(name: string, version: unknown): string {
  if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
    throw new Error(`${name} must use an exact package version.`);
  }
  return version;
}

function requireExactPackageManager(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  ) {
    throw new Error("packageManager must use an exact pnpm version.");
  }
  return value;
}

function requirePublicVersion(name: string, version: string): void {
  if (version.includes("-local.")) {
    throw new Error(`${name} must not use a local snapshot on the public channel.`);
  }
}

async function readCandidateReceipt(
  packageKey: PackageKey,
  expectedName: string,
  receiptPath: string | undefined,
): Promise<AuthoringReleaseSetV1["candidates"] extends infer Candidates
  ? Candidates extends Partial<Record<PackageKey, infer Candidate>>
    ? Candidate | undefined
    : never
  : never> {
  if (!receiptPath) {
    return undefined as never;
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<
    string,
    unknown
  >;
  const packageEntry =
    getObject(receipt.packages)?.[packageKey] ??
    getObject(receipt.packages)?.[expectedName] ??
    getObject(receipt.package) ??
    receipt;
  const packageObject = getObject(packageEntry);
  const name =
    stringValue(packageObject.name) ??
    stringValue(packageObject.packageName) ??
    expectedName;
  const version =
    stringValue(packageEntry) ??
    stringValue(packageObject.version) ??
    stringValue(packageObject.packageVersion) ??
    (packageKey === "sdk" ? stringValue(receipt.sdkVersion) : undefined);
  if (name !== expectedName) {
    throw new Error(`${receiptPath} describes ${name}, expected ${expectedName}.`);
  }
  const packageIntegrity =
    stringValue(packageObject.packageIntegrity) ??
    stringValue(packageObject.installedIntegrity) ??
    stringValue(receipt.packageIntegrity);
  const tarballSha512 =
    stringValue(packageObject.tarballSha512) ??
    stringValue(packageObject.integrity) ??
    stringValue(receipt.tarballSha512);
  return {
    name,
    version: requireExactVersion(`${expectedName} candidate`, version),
    receiptPath,
    ...(packageIntegrity ? { packageIntegrity } : {}),
    ...(tarballSha512 ? { tarballSha512 } : {}),
  } as never;
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function releaseSetId(releaseSet: Omit<AuthoringReleaseSetV1, "releaseSetId">) {
  return `sha256:${createHash("sha256")
    .update(stableJson(releaseSet))
    .digest("hex")}`;
}

const [rootPackage, cliPackage, apiClientPackage, devHostPackage] =
  await Promise.all([
    readPackageJson(path.join(repoRoot, "package.json")),
    readPackageJson(path.join(packageRoot, "package.json")),
    readPackageJson(
      path.join(repoRoot, "packages", "api-client", "package.json"),
    ),
    readPackageJson(path.join(repoRoot, "packages", "dev-host", "package.json")),
  ]);

const sdkVersion = requireExactVersion(
  "@dreamboard-games/sdk",
  cliPackage.devDependencies?.["@dreamboard-games/sdk"] ??
    devHostPackage.peerDependencies?.["@dreamboard-games/sdk"],
);
const channel =
  process.env.AUTHORING_RELEASE_CHANNEL === "maintainer-local"
    ? "maintainer-local"
    : "public";
const registryReceiptPath = stringValue(process.env.AUTHORING_REGISTRY_RECEIPT);
if (channel === "maintainer-local" && !registryReceiptPath) {
  throw new Error(
    "AUTHORING_REGISTRY_RECEIPT is required for maintainer-local release sets.",
  );
}
const candidates = Object.fromEntries(
  (
    await Promise.all([
      readCandidateReceipt(
        "sdk",
        "@dreamboard-games/sdk",
        stringValue(process.env.AUTHORING_SDK_CANDIDATE_RECEIPT),
      ),
      readCandidateReceipt(
        "apiClient",
        "@dreamboard-games/api-client",
        stringValue(process.env.AUTHORING_API_CLIENT_CANDIDATE_RECEIPT),
      ),
      readCandidateReceipt(
        "devHost",
        "@dreamboard-games/dev-host",
        stringValue(process.env.AUTHORING_DEV_HOST_CANDIDATE_RECEIPT),
      ),
    ])
  )
    .map((candidate, index) => {
      const key = ["sdk", "apiClient", "devHost"][index] as PackageKey;
      return candidate ? ([key, candidate] as const) : null;
    })
    .filter((entry): entry is readonly [PackageKey, NonNullable<typeof entry>[1]] =>
      entry !== null,
    ),
);
const packageVersions = {
  cli: requireExactVersion(
    "@dreamboard-games/cli",
    stringValue(process.env.AUTHORING_CLI_CANDIDATE_VERSION) ??
      cliPackage.version,
  ),
  sdk: candidates.sdk?.version ?? sdkVersion,
  apiClient:
    candidates.apiClient?.version ??
    requireExactVersion("@dreamboard-games/api-client", apiClientPackage.version),
  devHost:
    candidates.devHost?.version ??
    requireExactVersion(
      "@dreamboard-games/dev-host",
      stringValue(process.env.AUTHORING_DEV_HOST_CANDIDATE_VERSION) ??
        devHostPackage.version,
    ),
};
if (channel === "public") {
  for (const [name, version] of Object.entries(packageVersions)) {
    requirePublicVersion(name, version);
  }
  if (registryReceiptPath) {
    throw new Error("Public release sets must not include a registry receipt.");
  }
}
const releaseSetWithoutId: Omit<AuthoringReleaseSetV1, "releaseSetId"> = {
  schemaVersion: 1,
  channel,
  packages: {
    cli: {
      name: "@dreamboard-games/cli",
      version: packageVersions.cli,
    },
    sdk: {
      name: "@dreamboard-games/sdk",
      version: packageVersions.sdk,
    },
    apiClient: {
      name: "@dreamboard-games/api-client",
      version: packageVersions.apiClient,
    },
    devHost: {
      name: "@dreamboard-games/dev-host",
      version: packageVersions.devHost,
    },
  },
  protocols: {
    authoringAdapter: 1,
    devHost: 1,
    verifier: 1,
  },
  schemas: {
    scaffold: 2,
    manifest: 2,
    generatedArtifacts: 1,
  },
  registry: {
    kind: channel === "public" ? "public-npm" : "maintainer-local",
    portable: channel === "public",
    ...(registryReceiptPath ? { receiptPath: registryReceiptPath } : {}),
  },
  ...(Object.keys(candidates).length > 0 ? { candidates } : {}),
  packageManager: requireExactPackageManager(rootPackage.packageManager),
};
const releaseSet: AuthoringReleaseSetV1 = {
  ...releaseSetWithoutId,
  releaseSetId: releaseSetId(releaseSetWithoutId),
};

const source = `// Generated by scripts/generate-authoring-release-set.ts. Do not edit by hand.
import type { AuthoringReleaseSetV1 } from "./authoring-release-set.js";

export const AUTHORING_RELEASE_SET = ${JSON.stringify(releaseSet, null, 2)} as const satisfies AuthoringReleaseSetV1;
`;

await writeFile(outputPath, source, "utf8");
