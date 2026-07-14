import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AUTHORING_RELEASE_SET } from "../apps/dreamboard-cli/src/release/authoring-release-set.ts";
import {
  DEFAULT_CANDIDATE_ROOT,
  optionValue,
  type AuthoringReleaseCandidatePackageV1,
  type CandidatePackageKey,
} from "./authoring-release-candidate.ts";

type NpmPackResult = {
  name?: string;
  version?: string;
  filename?: string;
  integrity?: string;
  shasum?: string;
};

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.join(repoRoot, "apps/dreamboard-cli");
const devHostRoot = path.join(repoRoot, "packages/dev-host");
const outputRoot = path.resolve(
  optionValue(process.argv.slice(2), "--out", DEFAULT_CANDIDATE_ROOT),
);

await run("pnpm", ["--dir", cliRoot, "run", "build:published"]);
await run("pnpm", ["--dir", cliRoot, "run", "build:agent-verifier"]);
await run("pnpm", [
  "--dir",
  cliRoot,
  "exec",
  "tsx",
  "scripts/stage-publish.ts",
]);
await run("pnpm", [
  "--dir",
  cliRoot,
  "exec",
  "tsx",
  "scripts/stage-dev-host-package.ts",
]);
await run("pnpm", [
  "--dir",
  cliRoot,
  "run",
  "check:authoring-version-authority",
]);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const packages = await Promise.all([
  pack("devHost", path.join(devHostRoot, ".publish/package")),
  pack("cli", path.join(cliRoot, ".publish/package")),
]);
const sourceCommit = (
  await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
).stdout.trim();
const receipt = {
  schemaVersion: 1 as const,
  sourceCommit,
  releaseSet: AUTHORING_RELEASE_SET,
  packages,
};
const receiptPath = path.join(outputRoot, "receipt.json");
const temporaryReceiptPath = `${receiptPath}.tmp`;
await writeFile(
  temporaryReceiptPath,
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
await rename(temporaryReceiptPath, receiptPath);

console.log(`authoring release candidate written to ${receiptPath}`);

async function pack(
  key: CandidatePackageKey,
  packageRoot: string,
): Promise<AuthoringReleaseCandidatePackageV1> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", outputRoot, packageRoot],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const result = (JSON.parse(stdout) as NpmPackResult[])[0];
  if (
    !result?.name ||
    !result.version ||
    !result.filename ||
    !result.integrity ||
    !result.shasum
  ) {
    throw new Error(`npm pack returned incomplete metadata for ${key}.`);
  }
  const releaseEntry = AUTHORING_RELEASE_SET.packages[key];
  if (
    result.name !== releaseEntry.name ||
    result.version !== releaseEntry.version
  ) {
    throw new Error(
      `Packed ${result.name}@${result.version}; expected ${releaseEntry.name}@${releaseEntry.version}.`,
    );
  }
  return {
    key,
    name: result.name,
    version: result.version,
    file: result.filename,
    integrity: result.integrity,
    shasum: result.shasum,
  };
}

async function run(command: string, args: string[]): Promise<void> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}
