import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertCandidateFileIntegrity,
  readCandidateReceipt,
  resolveCandidateFile,
  type AuthoringReleaseCandidateReceiptV1,
} from "../../../../scripts/authoring-release-candidate.ts";

test("reads and verifies exact candidate tarball integrity", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "authoring-candidate-test-"),
  );
  try {
    const bytes = Buffer.from("verified package bytes");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const receipt = fixtureReceipt(integrity);
    await writeFile(path.join(root, "cli.tgz"), bytes);
    await writeFile(
      path.join(root, "dev-host.tgz"),
      Buffer.from("dev-host package bytes"),
    );
    receipt.packages[1]!.integrity = `sha512-${createHash("sha512")
      .update("dev-host package bytes")
      .digest("base64")}`;
    const receiptPath = path.join(root, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt));

    const parsed = await readCandidateReceipt(receiptPath);
    expect(
      await assertCandidateFileIntegrity(receiptPath, parsed.packages[0]!),
    ).toBe(path.join(root, "cli.tgz"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects candidate paths outside the receipt root", () => {
  const receipt = fixtureReceipt(`sha512-${"a".repeat(32)}`);
  const escaped = { ...receipt.packages[0]!, file: "../cli.tgz" };
  expect(() =>
    resolveCandidateFile("/tmp/candidate/receipt.json", escaped),
  ).toThrow("candidate path escapes the receipt root");
});

function fixtureReceipt(
  cliIntegrity: string,
): AuthoringReleaseCandidateReceiptV1 {
  return {
    schemaVersion: 1,
    sourceCommit: "0".repeat(40),
    releaseSet: {
      schemaVersion: 1,
      channel: "public",
      packages: {
        cli: { name: "@dreamboard-games/cli", version: "1.0.0" },
        sdk: { name: "@dreamboard-games/sdk", version: "2.0.0" },
        apiClient: {
          name: "@dreamboard-games/api-client",
          version: "3.0.0",
        },
        devHost: {
          name: "@dreamboard-games/dev-host",
          version: "4.0.0",
        },
      },
      protocols: { authoringAdapter: 1, devHost: 1, verifier: 1 },
      schemas: { scaffold: 2, manifest: 2, generatedArtifacts: 1 },
      registry: { kind: "public-npm", portable: true },
      packageManager: "pnpm@10.4.1",
      releaseSetId: `sha256:${"0".repeat(64)}`,
    },
    sdkInput: {
      name: "@dreamboard-games/sdk",
      version: "2.0.0",
      file: "inputs/sdk.tgz",
      registryTarball: "https://registry.npmjs.org/sdk/-/sdk-2.0.0.tgz",
      integrity: `sha512-${"b".repeat(32)}`,
    },
    apiClientProof: {
      file: "api-client-proof.json",
      integrity: `sha512-${"c".repeat(32)}`,
    },
    packages: [
      {
        key: "cli",
        name: "@dreamboard-games/cli",
        version: "1.0.0",
        file: "cli.tgz",
        integrity: cliIntegrity,
        shasum: "0".repeat(40),
      },
      {
        key: "devHost",
        name: "@dreamboard-games/dev-host",
        version: "4.0.0",
        file: "dev-host.tgz",
        integrity: `sha512-${"a".repeat(32)}`,
        shasum: "0".repeat(40),
      },
      {
        key: "apiClient",
        name: "@dreamboard-games/api-client",
        version: "3.0.0",
        file: "api-client.tgz",
        integrity: `sha512-${"d".repeat(32)}`,
        shasum: "0".repeat(40),
      },
    ],
  };
}
