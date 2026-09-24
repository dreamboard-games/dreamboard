export interface CandidatePackage {
  name: string;
  version: string;
  file: string;
  integrity: string;
}
export interface CandidateReceipt {
  schemaVersion: number;
  sourceCommit: string;
  sdkVersion: string;
  packages: CandidatePackage[];
}
export interface PackageManifest {
  name: string;
  version: string;
  dependencies: Record<string, string>;
}
export const runtimePackage = "@dreamboard-games/browser-gameplay-runtime";
export const hostPackage = "@dreamboard-games/dev-host";
export function validateCandidateCohort(
  receipt: CandidateReceipt,
  manifests: PackageManifest[],
): void {
  if (
    receipt.schemaVersion !== 2 ||
    receipt.packages.length !== 2 ||
    manifests.length !== 2
  )
    throw new Error("Expected exactly browser runtime and offline dev host");
  const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (
    !exactVersion.test(receipt.sdkVersion) ||
    receipt.packages.some((entry) => !exactVersion.test(entry.version))
  )
    throw new Error("Candidate package and SDK versions must be exact");
  const expected = [runtimePackage, hostPackage];
  if (receipt.packages.some((entry, index) => entry.name !== expected[index]))
    throw new Error(
      "Candidate package identities or publication order are invalid",
    );
  for (const [index, entry] of receipt.packages.entries()) {
    const manifest = manifests[index]!;
    if (manifest.name !== entry.name || manifest.version !== entry.version)
      throw new Error("Package identity mismatch");
    if (manifest.dependencies["@dreamboard-games/sdk"] !== receipt.sdkVersion)
      throw new Error("SDK dependency does not match candidate receipt");
    if (JSON.stringify(manifest).includes("workspace:"))
      throw new Error("Unresolved workspace dependency");
  }
  if (
    manifests[1]!.dependencies[runtimePackage] !== receipt.packages[0]!.version
  )
    throw new Error(
      "Dev host must require the exact candidate browser runtime version",
    );
}
export function validateInstalledProof(
  receipt: CandidateReceipt,
  proof: {
    sourceCommit: string;
    sdkVersion: string;
    packages: CandidatePackage[];
    browsers: string[];
  },
): void {
  if (
    proof.sourceCommit !== receipt.sourceCommit ||
    proof.sdkVersion !== receipt.sdkVersion ||
    JSON.stringify(proof.packages) !== JSON.stringify(receipt.packages) ||
    !["chromium", "webkit"].every((browser) => proof.browsers.includes(browser))
  )
    throw new Error(
      "Installed browser proof must cover these exact candidate tarballs and source",
    );
}
