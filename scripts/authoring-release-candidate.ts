import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuthoringReleaseSetV1 } from "../apps/dreamboard-cli/src/release/authoring-release-set.ts";

export type CandidatePackageKey = "cli" | "devHost";

export type AuthoringReleaseCandidatePackageV1 = {
  key: CandidatePackageKey;
  name: string;
  version: string;
  file: string;
  integrity: string;
  shasum: string;
};

export type AuthoringReleaseCandidateReceiptV1 = {
  schemaVersion: 1;
  sourceCommit: string;
  releaseSet: AuthoringReleaseSetV1;
  packages: AuthoringReleaseCandidatePackageV1[];
};

export const DEFAULT_CANDIDATE_ROOT = path.resolve(
  import.meta.dirname,
  "../build/release-candidate",
);

export function optionValue(
  args: string[],
  name: string,
  defaultValue?: string,
): string {
  const index = args.indexOf(name);
  if (index === -1) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`${name} is required.`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export async function readCandidateReceipt(
  receiptPath: string,
): Promise<AuthoringReleaseCandidateReceiptV1> {
  const receipt = JSON.parse(
    await readFile(receiptPath, "utf8"),
  ) as AuthoringReleaseCandidateReceiptV1;
  if (receipt.schemaVersion !== 1) {
    throw new Error(`Unsupported candidate receipt schema at ${receiptPath}.`);
  }
  if (receipt.releaseSet.schemaVersion !== 1) {
    throw new Error(`Unsupported authoring release set in ${receiptPath}.`);
  }
  const keys = receipt.packages.map((entry) => entry.key).sort();
  if (keys.join(",") !== "cli,devHost") {
    throw new Error(`${receiptPath} must contain exactly CLI and dev-host.`);
  }
  for (const entry of receipt.packages) {
    const releaseEntry = receipt.releaseSet.packages[entry.key];
    if (
      entry.name !== releaseEntry.name ||
      entry.version !== releaseEntry.version
    ) {
      throw new Error(
        `${entry.key} candidate does not match the embedded release set.`,
      );
    }
    if (!entry.integrity.startsWith("sha512-")) {
      throw new Error(`${entry.name} candidate is missing sha512 integrity.`);
    }
  }
  return receipt;
}

export function candidatePackage(
  receipt: AuthoringReleaseCandidateReceiptV1,
  key: CandidatePackageKey,
): AuthoringReleaseCandidatePackageV1 {
  const entry = receipt.packages.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Candidate receipt is missing ${key}.`);
  return entry;
}

export function resolveCandidateFile(
  receiptPath: string,
  entry: AuthoringReleaseCandidatePackageV1,
): string {
  const receiptRoot = path.dirname(path.resolve(receiptPath));
  const filePath = path.resolve(receiptRoot, entry.file);
  if (
    filePath !== receiptRoot &&
    !filePath.startsWith(`${receiptRoot}${path.sep}`)
  ) {
    throw new Error(`${entry.name} candidate path escapes the receipt root.`);
  }
  return filePath;
}

export async function assertCandidateFileIntegrity(
  receiptPath: string,
  entry: AuthoringReleaseCandidatePackageV1,
): Promise<string> {
  const filePath = resolveCandidateFile(receiptPath, entry);
  const bytes = await readFile(filePath);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== entry.integrity) {
    throw new Error(
      `${entry.name}@${entry.version} integrity mismatch: receipt has ${entry.integrity}, file has ${integrity}.`,
    );
  }
  return filePath;
}
