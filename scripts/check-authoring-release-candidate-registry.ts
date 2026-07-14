import path from "node:path";
import {
  assertCandidateFileIntegrity,
  DEFAULT_CANDIDATE_ROOT,
  optionValue,
  readCandidateReceipt,
} from "./authoring-release-candidate.ts";

type ExpectedState = "unpublished" | "resume" | "published";
type NpmVersionMetadata = {
  dist?: { integrity?: string };
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

for (const key of ["sdk", "apiClient"] as const) {
  const entry = receipt.releaseSet.packages[key];
  const metadata = await fetchVersion(entry.name, entry.version);
  if (!metadata) {
    throw new Error(`${entry.name}@${entry.version} is not published.`);
  }
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
