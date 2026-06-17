#!/usr/bin/env tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCandidateSet,
  type AuthoringCompatibilityCandidateV1,
} from "./candidate.ts";
import { startIsolatedRegistry } from "./isolated-registry.ts";
import { proveScaffoldAndInstall } from "./scaffold-proof.ts";
import { proveAdapter } from "./adapter-proof.ts";
import { proveGeneratedArtifacts } from "./generated-artifact-proof.ts";
import { writeReceipt } from "./receipt.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidateInput: AuthoringCompatibilityCandidateV1 = {
    sdkTarball: required(args, "--sdk-tarball"),
    apiClientTarball: required(args, "--api-client-tarball"),
    devHostTarball: required(args, "--dev-host-tarball"),
    cliTarball: required(args, "--cli-tarball"),
    expectedReleaseSetId: args["--expected-release-set-id"],
    channel:
      args["--channel"] === "maintainer-local" ? "maintainer-local" : "public",
  };

  const candidateSet = await loadCandidateSet(candidateInput);
  const registry = await startIsolatedRegistry(candidateSet);
  try {
    const scaffold = await proveScaffoldAndInstall({
      candidateSet,
      registry,
      keepTemp: args["--keep-temp"] === "true",
    });
    const adapter = await proveAdapter(scaffold);
    const generatedArtifacts = await proveGeneratedArtifacts(scaffold);
    const { receiptPath } = await writeReceipt({
      repoRoot,
      candidateSet,
      registry,
      scaffold,
      adapter,
      generatedArtifacts,
    });
    console.log(`Authoring compatibility receipt: ${receiptPath}`);
  } finally {
    await registry.stop();
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected argument ${key ?? ""}`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required ${key}.`);
  }
  return value;
}

await main();
