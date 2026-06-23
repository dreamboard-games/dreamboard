import { pathToFileURL } from "node:url";
import {
  AUTHORING_RELEASE_SET,
  type AuthoringReleaseSetV1,
} from "../src/release/authoring-release-set.ts";

type NpmTag = "alpha" | "latest";
type CheckedPackageKey = "sdk" | "apiClient" | "devHost";

type NpmPackument = {
  "dist-tags"?: Record<string, string | undefined>;
};

type FetchPackument = (packageName: string) => Promise<NpmPackument>;

type FreshnessProblem = {
  packageName: string;
  releaseSetVersion: string;
  targetTag: NpmTag;
  npmTagVersion?: string;
  reason: "missing-tag" | "stale" | "metadata";
  message: string;
};

type FreshnessNote = {
  packageName: string;
  releaseSetVersion: string;
  targetTag: NpmTag;
  npmTagVersion: string;
  message: string;
};

type FreshnessResult = {
  allowStale: boolean;
  targetTag: NpmTag;
  problems: FreshnessProblem[];
  notes: FreshnessNote[];
};

const checkedPackageKeys: CheckedPackageKey[] = [
  "sdk",
  "apiClient",
  "devHost",
];

const staleOverrideEnv = "AUTHORING_RELEASE_SET_ALLOW_STALE_NPM";
const tagOverrideEnv = "AUTHORING_RELEASE_NPM_TAG";

function isNpmTag(value: string | undefined): value is NpmTag {
  return value === "alpha" || value === "latest";
}

export function targetNpmTagFromReleaseSet(
  releaseSet: AuthoringReleaseSetV1,
  env: Record<string, string | undefined> = process.env,
): NpmTag {
  const override = env[tagOverrideEnv];
  if (override !== undefined) {
    if (isNpmTag(override)) {
      return override;
    }
    throw new Error(
      `${tagOverrideEnv} must be either alpha or latest, got ${JSON.stringify(override)}.`,
    );
  }

  return releaseSet.packages.cli.version.includes("-alpha.")
    ? "alpha"
    : "latest";
}

function compareSemverLike(left: string, right: string): number {
  const leftParts = parseSemverLike(left);
  const rightParts = parseSemverLike(right);

  for (const key of ["major", "minor", "patch"] as const) {
    const difference = leftParts[key] - rightParts[key];
    if (difference !== 0) return Math.sign(difference);
  }

  return comparePrerelease(leftParts.prerelease, rightParts.prerelease);
}

function parseSemverLike(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    version,
  );
  if (!match) {
    throw new Error(`Unsupported npm version '${version}'.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = numericIdentifier(leftPart);
    const rightNumber = numericIdentifier(rightPart);
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return Math.sign(leftNumber - rightNumber);
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function numericIdentifier(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value);
}

export async function fetchPublicNpmPackument(
  packageName: string,
): Promise<NpmPackument> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
  );
  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for ${packageName}.`,
    );
  }
  return (await response.json()) as NpmPackument;
}

export async function inspectAuthoringReleaseSetNpmFreshness(options?: {
  releaseSet?: AuthoringReleaseSetV1;
  env?: Record<string, string | undefined>;
  fetchPackument?: FetchPackument;
}): Promise<FreshnessResult> {
  const releaseSet = options?.releaseSet ?? AUTHORING_RELEASE_SET;
  const env = options?.env ?? process.env;
  const fetchPackument = options?.fetchPackument ?? fetchPublicNpmPackument;
  const targetTag = targetNpmTagFromReleaseSet(releaseSet, env);
  const allowStale = env[staleOverrideEnv] === "1";
  const problems: FreshnessProblem[] = [];
  const notes: FreshnessNote[] = [];

  for (const packageKey of checkedPackageKeys) {
    const entry = releaseSet.packages[packageKey];
    let packument: NpmPackument;
    try {
      packument = await fetchPackument(entry.name);
    } catch (error) {
      problems.push({
        packageName: entry.name,
        releaseSetVersion: entry.version,
        targetTag,
        reason: "metadata",
        message: `${entry.name} metadata could not be fetched for npm ${targetTag}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    const npmTagVersion = packument["dist-tags"]?.[targetTag];
    if (!npmTagVersion) {
      problems.push({
        packageName: entry.name,
        releaseSetVersion: entry.version,
        targetTag,
        npmTagVersion,
        reason: "missing-tag",
        message: `${entry.name} is missing npm ${targetTag} dist-tag.`,
      });
      continue;
    }

    const comparison = compareSemverLike(entry.version, npmTagVersion);
    if (comparison < 0) {
      problems.push({
        packageName: entry.name,
        releaseSetVersion: entry.version,
        targetTag,
        npmTagVersion,
        reason: "stale",
        message: `${entry.name} is stale: release set has ${entry.version}, npm ${targetTag} is ${npmTagVersion}.`,
      });
    } else if (comparison > 0) {
      notes.push({
        packageName: entry.name,
        releaseSetVersion: entry.version,
        targetTag,
        npmTagVersion,
        message: `${entry.name} appears pending: release set has ${entry.version}, npm ${targetTag} is ${npmTagVersion}.`,
      });
    }
  }

  return {
    allowStale,
    targetTag,
    problems,
    notes,
  };
}

function formatProblems(result: FreshnessResult): string {
  const remediation = `Update the package pin, regenerate the authoring release set, or set ${staleOverrideEnv}=1 if this stale release set is intentional.`;
  return [
    `Authoring release set npm freshness check failed for target tag ${result.targetTag}:`,
    ...result.problems.map((problem) => `- ${problem.message}`),
    "",
    remediation,
  ].join("\n");
}

export async function assertAuthoringReleaseSetNpmFreshness(options?: {
  releaseSet?: AuthoringReleaseSetV1;
  env?: Record<string, string | undefined>;
  fetchPackument?: FetchPackument;
  logger?: Pick<Console, "log" | "warn">;
}): Promise<FreshnessResult> {
  const result = await inspectAuthoringReleaseSetNpmFreshness(options);
  const logger = options?.logger ?? console;

  for (const note of result.notes) {
    logger.log(note.message);
  }

  if (result.problems.length === 0) {
    logger.log(
      `authoring release set npm freshness check passed for target tag ${result.targetTag}`,
    );
    return result;
  }

  const message = formatProblems(result);
  if (result.allowStale) {
    logger.warn(message);
    return result;
  }

  throw new Error(message);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (import.meta.url === invokedPath) {
  await assertAuthoringReleaseSetNpmFreshness();
}
