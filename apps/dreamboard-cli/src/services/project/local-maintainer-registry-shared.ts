import crypto from "node:crypto";
import path from "node:path";
import { BUILD_CHANNEL, IS_PUBLISHED_BUILD } from "../../build-target.js";
import { ENVIRONMENT_CONFIGS } from "../../constants.js";
import type {
  LocalMaintainerRegistryConfig,
  LocalMaintainerRegistryPackages,
  LocalMaintainerSdkPackageName,
} from "../../types.js";
import { exists, readJsonFile } from "../../utils/fs.js";

const localRegistryAddress = readLocalRegistryAddress();
export const LOCAL_REGISTRY_HOST = localRegistryAddress.host;
export const LOCAL_REGISTRY_PORT = localRegistryAddress.port;
export const LOCAL_REGISTRY_URL = `http://${LOCAL_REGISTRY_HOST}:${LOCAL_REGISTRY_PORT}`;
export const LOCAL_SCOPE_NPMRC_CONTENT = `@dreamboard-games:registry=${LOCAL_REGISTRY_URL}\n`;
export const SDK_PUBLISH_ORDER: readonly LocalMaintainerSdkPackageName[] = [
  "@dreamboard-games/sdk",
];

export type PackageJsonShape = {
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  typesVersions?: Record<string, unknown>;
  files?: string[];
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readLocalRegistryAddress(): { host: string; port: number } {
  const urlOverride = process.env.DREAMBOARD_LOCAL_REGISTRY_URL?.trim();
  const hostOverride = process.env.DREAMBOARD_LOCAL_REGISTRY_HOST?.trim();
  const portOverride = process.env.DREAMBOARD_LOCAL_REGISTRY_PORT?.trim();
  if (urlOverride) {
    let parsed: URL;
    try {
      parsed = new URL(urlOverride);
    } catch {
      throw new Error(
        `Invalid DREAMBOARD_LOCAL_REGISTRY_URL '${urlOverride}'. Expected an http://host:port URL.`,
      );
    }
    if (parsed.protocol !== "http:" || !parsed.hostname || !parsed.port) {
      throw new Error(
        `Invalid DREAMBOARD_LOCAL_REGISTRY_URL '${urlOverride}'. Expected an http://host:port URL.`,
      );
    }
    return {
      host: hostOverride || parsed.hostname,
      port: parseLocalRegistryPort(portOverride || parsed.port),
    };
  }
  return {
    host: hostOverride || "127.0.0.1",
    port: portOverride ? parseLocalRegistryPort(portOverride) : 4873,
  };
}

function parseLocalRegistryPort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid DREAMBOARD_LOCAL_REGISTRY_PORT '${raw}'. Expected a TCP port from 1 to 65535.`,
    );
  }
  return port;
}

export function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function isLocalMaintainerRegistryEnabled(apiBaseUrl: string): boolean {
  let isLocalLoopbackUrl = false;
  try {
    const parsed = new URL(apiBaseUrl);
    isLocalLoopbackUrl =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    isLocalLoopbackUrl = false;
  }

  return (
    !IS_PUBLISHED_BUILD &&
    (apiBaseUrl === ENVIRONMENT_CONFIGS.local?.apiBaseUrl ||
      isLocalLoopbackUrl) &&
    BUILD_CHANNEL === "development"
  );
}

export function packageShortName(
  packageName: LocalMaintainerSdkPackageName,
): string {
  return packageName.replace(/^@dreamboard(?:-games)?\//, "");
}

export async function readWorkspaceLocalMaintainerRegistryFromPackageJson(
  projectRoot: string,
  fallbackRegistryUrl: string = LOCAL_REGISTRY_URL,
): Promise<LocalMaintainerRegistryConfig | null> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }

  const packageJson = await readJsonFile<PackageJsonShape>(packageJsonPath);
  const sdkVersion =
    packageJson.dependencies?.["@dreamboard-games/sdk"] ??
    packageJson.devDependencies?.["@dreamboard-games/sdk"];
  const apiClientVersion =
    packageJson.dependencies?.["@dreamboard-games/api-client"] ??
    packageJson.devDependencies?.["@dreamboard-games/api-client"];
  const sdkDependencyVersion =
    packageJson.dependencies?.["@dreamboard-games/sdk"];
  if (!sdkVersion?.includes("-local.") || !sdkDependencyVersion) {
    return null;
  }
  const localSdkVersion = sdkVersion;

  const fingerprintSource = [
    apiClientVersion ?? "",
    localSdkVersion,
    fallbackRegistryUrl,
  ].join(":");
  return {
    registryUrl: fallbackRegistryUrl,
    snapshotId: shortHash(fingerprintSource),
    fingerprint: shortHash(fingerprintSource),
    publishedAt: "",
    packages: {
      "@dreamboard-games/api-client": apiClientVersion,
      "@dreamboard-games/sdk": localSdkVersion,
    } satisfies LocalMaintainerRegistryPackages,
  };
}

export function getLocalMaintainerNpmrcContent(
  localMaintainerRegistry: LocalMaintainerRegistryConfig | null | undefined,
): string | null {
  if (!localMaintainerRegistry) {
    return null;
  }
  return LOCAL_SCOPE_NPMRC_CONTENT.replace(
    LOCAL_REGISTRY_URL,
    localMaintainerRegistry.registryUrl,
  );
}

export function didLocalMaintainerSnapshotChange(
  previous: LocalMaintainerRegistryConfig | undefined,
  next: LocalMaintainerRegistryConfig | null,
): boolean {
  if (!next) {
    return false;
  }
  return previous?.snapshotId !== next.snapshotId;
}

export function isLocalMaintainerRegistryUrl(
  fileContent: string | null,
): boolean {
  if (!fileContent) {
    return false;
  }
  return /@dreamboard-games:registry=http:\/\/127\.0\.0\.1:\d+/.test(
    fileContent,
  );
}
