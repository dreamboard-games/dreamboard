import { expect, test, vi } from "vitest";
import {
  type PackageManifest,
  hostPackage,
  runtimePackage,
  validateCandidateCohort,
  validateInstalledProof,
  verifyPublishedIntegrity,
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
    sdkVersion: "0.5.0-alpha.3",
    packages,
  };
  const manifests: PackageManifest[] = packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    repository: {
      type: "git",
      url: "https://github.com/dreamboard-games/dreamboard.git",
      directory:
        entry.name === runtimePackage
          ? "packages/browser-gameplay-runtime"
          : "packages/dev-host",
    },
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

for (const index of [0, 1]) {
  test.each(["missing", "url", "directory", "type"] as const)(
    `rejects %s provenance repository metadata for package ${index}`,
    (field) => {
      const { receipt, manifests } = candidate();
      if (field === "missing") delete manifests[index]!.repository;
      else manifests[index]!.repository![field] = "incorrect";
      expect(() => validateCandidateCohort(receipt, manifests)).toThrow(
        /provenance repository metadata/,
      );
    },
  );
}

test("waits for missing published metadata without republishing", async () => {
  vi.useFakeTimers();
  try {
    const entry = candidate().receipt.packages[0]!;
    const read = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(entry.integrity);
    const verified = verifyPublishedIntegrity(entry, read);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await verified;
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith(entry.name, entry.version);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
test("fails immediately for a published integrity mismatch", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockReturnValue("sha512-other");
    await expect(
      verifyPublishedIntegrity(candidate().receipt.packages[0]!, read),
    ).rejects.toThrow("Published integrity mismatch");
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
test("bounds missing-version convergence to twenty minutes", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn().mockReturnValue(null);
    const verified = verifyPublishedIntegrity(
      candidate().receipt.packages[0]!,
      read,
    );
    const rejected = expect(verified).rejects.toThrow("within 20 minutes");
    await vi.advanceTimersByTimeAsync(1_200_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(121);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
