import { expect, test } from "bun:test";
import type { AuthoringReleaseSetV1 } from "./authoring-release-set.js";
import {
  assertAuthoringReleaseSetNpmFreshness,
  inspectAuthoringReleaseSetNpmFreshness,
  targetNpmTagFromReleaseSet,
} from "../../scripts/check-authoring-release-set-npm-freshness.ts";

const baseReleaseSet: AuthoringReleaseSetV1 = {
  schemaVersion: 1,
  channel: "public",
  packages: {
    cli: {
      name: "@dreamboard-games/cli",
      version: "9.0.0-alpha.1",
    },
    sdk: {
      name: "@dreamboard-games/sdk",
      version: "9.0.0-alpha.2",
    },
    apiClient: {
      name: "@dreamboard-games/api-client",
      version: "9.0.0-alpha.3",
    },
    devHost: {
      name: "@dreamboard-games/dev-host",
      version: "9.0.0-alpha.4",
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
    kind: "public-npm",
    portable: true,
  },
  packageManager: "pnpm@10.4.1",
  releaseSetId: `sha256:${"0".repeat(64)}`,
};

test("passes when release-set package versions match npm target dist-tags", async () => {
  const result = await inspectAuthoringReleaseSetNpmFreshness({
    releaseSet: baseReleaseSet,
    env: {},
    fetchPackument: async (packageName) => ({
      "dist-tags": {
        alpha: versionFor(packageName),
      },
    }),
  });

  expect(result.targetTag).toBe("alpha");
  expect(result.problems).toEqual([]);
  expect(result.notes).toEqual([]);
});

test("fails when SDK is behind npm alpha", async () => {
  await expect(
    assertAuthoringReleaseSetNpmFreshness({
      releaseSet: {
        ...baseReleaseSet,
        packages: {
          ...baseReleaseSet.packages,
          sdk: {
            name: "@dreamboard-games/sdk",
            version: "9.0.0-alpha.1",
          },
        },
      },
      env: {},
      fetchPackument: async (packageName) => ({
        "dist-tags": {
          alpha:
            packageName === "@dreamboard-games/sdk"
              ? "9.0.0-alpha.2"
              : versionFor(packageName),
        },
      }),
      logger: silentLogger,
    }),
  ).rejects.toThrow(
    "@dreamboard-games/sdk is stale: release set has 9.0.0-alpha.1, npm alpha is 9.0.0-alpha.2.",
  );
});

test("allows package versions ahead of the npm target dist-tag", async () => {
  const messages: string[] = [];

  const result = await assertAuthoringReleaseSetNpmFreshness({
    releaseSet: {
      ...baseReleaseSet,
      packages: {
        ...baseReleaseSet.packages,
        sdk: {
          name: "@dreamboard-games/sdk",
          version: "9.0.0-alpha.3",
        },
      },
    },
    env: {},
    fetchPackument: async (packageName) => ({
      "dist-tags": {
        alpha:
          packageName === "@dreamboard-games/sdk"
            ? "9.0.0-alpha.2"
            : versionFor(packageName),
      },
    }),
    logger: {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });

  expect(result.problems).toEqual([]);
  expect(result.notes).toHaveLength(1);
  expect(messages.join("\n")).toContain(
    "@dreamboard-games/sdk appears pending: release set has 9.0.0-alpha.3, npm alpha is 9.0.0-alpha.2.",
  );
});

test("honors explicit latest npm tag override", () => {
  expect(
    targetNpmTagFromReleaseSet(baseReleaseSet, {
      AUTHORING_RELEASE_NPM_TAG: "latest",
    }),
  ).toBe("latest");
});

test("stale override converts freshness failures into warnings", async () => {
  const warnings: string[] = [];

  const result = await assertAuthoringReleaseSetNpmFreshness({
    releaseSet: {
      ...baseReleaseSet,
      packages: {
        ...baseReleaseSet.packages,
        sdk: {
          name: "@dreamboard-games/sdk",
          version: "9.0.0-alpha.1",
        },
      },
    },
    env: {
      AUTHORING_RELEASE_SET_ALLOW_STALE_NPM: "1",
    },
    fetchPackument: async (packageName) => ({
      "dist-tags": {
        alpha:
          packageName === "@dreamboard-games/sdk"
            ? "9.0.0-alpha.2"
            : versionFor(packageName),
      },
    }),
    logger: {
      log: () => {},
      warn: (message) => warnings.push(message),
    },
  });

  expect(result.problems).toHaveLength(1);
  expect(warnings.join("\n")).toContain(
    "set AUTHORING_RELEASE_SET_ALLOW_STALE_NPM=1",
  );
});

const silentLogger = {
  log: () => {},
  warn: () => {},
};

function versionFor(packageName: string): string {
  const packageEntry = Object.values(baseReleaseSet.packages).find(
    (entry) => entry.name === packageName,
  );
  if (!packageEntry) {
    throw new Error(`Unexpected package ${packageName}`);
  }
  return packageEntry.version;
}
