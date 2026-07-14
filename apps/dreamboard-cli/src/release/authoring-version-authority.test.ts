import { expect, test } from "bun:test";
import {
  inspectAuthoringSourceVersionAuthority,
  type AuthoringSourcePackages,
} from "../../scripts/authoring-version-authority.ts";
import type { AuthoringReleaseSetV1 } from "./authoring-release-set.js";

const releaseSet: AuthoringReleaseSetV1 = {
  schemaVersion: 1,
  channel: "public",
  packages: {
    cli: { name: "@dreamboard-games/cli", version: "1.0.0" },
    sdk: { name: "@dreamboard-games/sdk", version: "2.0.0" },
    apiClient: { name: "@dreamboard-games/api-client", version: "3.0.0" },
    devHost: { name: "@dreamboard-games/dev-host", version: "4.0.0" },
  },
  protocols: { authoringAdapter: 1, devHost: 1, verifier: 1 },
  schemas: { scaffold: 2, manifest: 2, generatedArtifacts: 1 },
  registry: { kind: "public-npm", portable: true },
  packageManager: "pnpm@10.4.1",
  releaseSetId: `sha256:${"0".repeat(64)}`,
};

const matchingPackages: AuthoringSourcePackages = {
  cli: {
    version: "1.0.0",
    devDependencies: { "@dreamboard-games/sdk": "2.0.0" },
  },
  apiClient: { version: "3.0.0" },
  devHost: {
    version: "4.0.0",
    dependencies: { "@dreamboard-games/sdk": "2.0.0" },
    peerDependencies: { "@dreamboard-games/sdk": "2.0.0" },
  },
};

test("accepts a source tuple matching the release set", () => {
  expect(
    inspectAuthoringSourceVersionAuthority(releaseSet, matchingPackages),
  ).toEqual([]);
});

test("reports a dev-host SDK peer mismatch without staged packages", () => {
  const failures = inspectAuthoringSourceVersionAuthority(releaseSet, {
    ...matchingPackages,
    devHost: {
      ...matchingPackages.devHost,
      peerDependencies: { "@dreamboard-games/sdk": "1.9.0" },
    },
  });

  expect(failures).toContain(
    "dev-host SDK peer is 1.9.0; expected 2.0.0 from the release set",
  );
});
