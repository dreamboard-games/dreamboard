import { expect, test } from "vitest";
import {
  hostPackage,
  runtimePackage,
  validateCandidateCohort,
  validateInstalledProof,
} from "./release-candidate-validation.ts";
function candidate() {
  const packages = [
    {
      name: runtimePackage,
      version: "0.1.0-alpha.2",
      file: "runtime.tgz",
      integrity: "sha512-runtime",
    },
    {
      name: hostPackage,
      version: "0.2.0-alpha.2",
      file: "host.tgz",
      integrity: "sha512-host",
    },
  ];
  const receipt = {
    schemaVersion: 2,
    sourceCommit: "abc",
    sdkVersion: "0.5.0-alpha.1",
    packages,
  };
  const manifests = packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    dependencies: {
      "@dreamboard-games/sdk": receipt.sdkVersion,
      ...(entry.name === hostPackage
        ? { [runtimePackage]: packages[0]!.version }
        : {}),
    },
  }));
  return { receipt, manifests };
}
test("requires the exact runtime/devhost cohort and rejects mismatched dependency even when an install override could hide it", () => {
  const { receipt, manifests } = candidate();
  expect(() => validateCandidateCohort(receipt, manifests)).not.toThrow();
  manifests[1]!.dependencies[runtimePackage] = "0.0.9";
  expect(() => validateCandidateCohort(receipt, manifests)).toThrow(
    /exact candidate browser runtime/,
  );
});
test("rejects duplicate or substituted packages", () => {
  const { receipt, manifests } = candidate();
  receipt.packages[1] = { ...receipt.packages[0]! };
  manifests[1] = { ...manifests[0]! };
  expect(() => validateCandidateCohort(receipt, manifests)).toThrow(
    /identities/,
  );
});
test("publication proof must bind exact tarballs and both browsers", () => {
  const { receipt } = candidate();
  const proof = { ...receipt, browsers: ["chromium", "webkit"] };
  expect(() => validateInstalledProof(receipt, proof)).not.toThrow();
  expect(() =>
    validateInstalledProof(receipt, {
      ...proof,
      packages: proof.packages.map((p) => ({
        ...p,
        integrity: "sha512-changed",
      })),
    }),
  ).toThrow(/exact candidate/);
  expect(() =>
    validateInstalledProof(receipt, { ...proof, browsers: ["chromium"] }),
  ).toThrow(/exact candidate/);
});
