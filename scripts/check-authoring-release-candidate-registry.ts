import path from "node:path";
import {
  assertCandidateFileIntegrity,
  assertReceiptFileIntegrity,
  DEFAULT_CANDIDATE_ROOT,
  optionValue,
  readCandidateReceipt,
} from "./authoring-release-candidate.ts";

type ExpectedState = "unpublished" | "resume" | "published";
type NpmVersionMetadata = {
  dist?: { integrity?: string; tarball?: string };
};

const args = process.argv.slice(2);
const receiptPath = path.resolve(
  optionValue(
    args,
    "--candidate",
    path.join(DEFAULT_CANDIDATE_ROOT, "receipt.json"),
  ),
);
const expected = optionValue(args, "--expect", "unpublished") as ExpectedState;
if (!(["unpublished", "resume", "published"] as const).includes(expected)) {
  throw new Error("--expect must be unpublished, resume, or published.");
}

const receipt = await readCandidateReceipt(receiptPath);
for (const entry of receipt.packages) {
  await assertCandidateFileIntegrity(receiptPath, entry);
}
await assertReceiptFileIntegrity(receiptPath, receipt.sdkInput, "SDK input");
await assertReceiptFileIntegrity(
  receiptPath,
  receipt.apiClientProof,
  "API-client proof",
);

const sdk = receipt.releaseSet.packages.sdk;
const sdkMetadata = await fetchVersion(sdk.name, sdk.version);
if (!sdkMetadata) {
  throw new Error(`${sdk.name}@${sdk.version} is not published.`);
}
if (sdkMetadata.dist?.integrity !== receipt.sdkInput.integrity) {
  throw new Error(
    `${sdk.name}@${sdk.version} registry integrity does not match the immutable SDK input.`,
  );
}
if (sdkMetadata.dist?.tarball !== receipt.sdkInput.registryTarball) {
  throw new Error(
    `${sdk.name}@${sdk.version} registry tarball URL does not match the immutable SDK input.`,
  );
}

for (const entry of receipt.packages) {
  const metadata = await fetchVersion(entry.name, entry.version);
  if (expected === "unpublished") {
    if (metadata) {
      throw new Error(
        `${entry.name}@${entry.version} already exists; choose a new version or use an explicit resume after verifying integrity.`,
      );
    }
    continue;
  }
  if (!metadata) {
    if (expected === "published") {
      throw new Error(`${entry.name}@${entry.version} is not published.`);
    }
    continue;
  }
  if (metadata.dist?.integrity !== entry.integrity) {
    throw new Error(
      `${entry.name}@${entry.version} registry integrity does not match the verified candidate.`,
    );
  }
}

console.log(`registry state matches ${expected} candidate expectation`);

async function fetchVersion(
  name: string,
  version: string,
): Promise<NpmVersionMetadata | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for ${name}@${version}.`,
    );
  }
  return (await response.json()) as NpmVersionMetadata;
}
