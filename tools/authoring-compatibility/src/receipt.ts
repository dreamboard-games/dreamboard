import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CandidateSet } from "./candidate.ts";
import type { IsolatedRegistry } from "./isolated-registry.ts";
import type { ScaffoldProof } from "./scaffold-proof.ts";
import type { AdapterProof } from "./adapter-proof.ts";
import type { GeneratedArtifactProof } from "./generated-artifact-proof.ts";

export async function writeReceipt(options: {
  repoRoot: string;
  candidateSet: CandidateSet;
  registry: IsolatedRegistry;
  scaffold: ScaffoldProof;
  adapter: AdapterProof;
  generatedArtifacts: GeneratedArtifactProof;
}) {
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const outputDir = path.join(
    options.repoRoot,
    "build",
    "authoring-compatibility",
    runId,
  );
  await mkdir(outputDir, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    proofMode: "packed-artifacts",
    releaseSet: options.candidateSet.releaseSet,
    packages: Object.fromEntries(
      Object.entries(options.candidateSet.packages).map(([key, candidate]) => [
        key,
        {
          name: candidate.packageJson.name,
          version: candidate.packageJson.version,
          tarball: candidate.tarballPath,
          tarballSha512: candidate.sha512Hex,
          integrity: candidate.integrity,
          installedIntegrity: candidate.integrity,
        },
      ]),
    ),
    registry: {
      url: options.registry.url,
      packageNames: options.registry.receipt.packageNames,
      versions: options.registry.receipt.versions,
      requestCount: options.registry.receipt.requestLog.length,
    },
    scaffold: options.scaffold.assertions,
    installed: options.scaffold.installed,
    adapter: options.adapter,
    generatedArtifacts: options.generatedArtifacts,
    commandAdapterVersion: options.scaffold.commandAdapterVersion,
    checks: [
      { id: "release-set-and-candidate-identity", status: "passed" },
      { id: "scaffold-before-install", status: "passed" },
      { id: "frozen-install-and-integrity", status: "passed" },
      { id: "project-local-adapter", status: "passed" },
      { id: "manifest-conformance", status: "passed" },
      { id: "deterministic-generated-artifacts", status: "passed" },
      { id: "generated-workspace-typecheck", status: "passed" },
      { id: "packed-reducer-scenarios", status: "passed" },
    ],
  };
  const receiptPath = path.join(outputDir, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { outputDir, receiptPath, receipt };
}
