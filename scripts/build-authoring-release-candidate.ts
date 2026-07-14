import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

type RegistryVersionMetadata = {
  dist?: { tarball?: string; integrity?: string };
};

type ApiClientProof = {
  schemaVersion: 1;
  package: {
    name: string;
    version: string;
    tarball: string;
    integrity: string;
  };
  sdkInput: {
    name: string;
    version: string;
    integrity: string;
  };
};

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.join(repoRoot, "apps/dreamboard-cli");
const devHostRoot = path.join(repoRoot, "packages/dev-host");
const apiClientRoot = path.join(repoRoot, "packages/api-client");
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

const sdkInput = await downloadSdkInput();
const apiClientProofRoot = path.join(outputRoot, ".api-client-proof");
await run("pnpm", ["--dir", apiClientRoot, "run", "authoring:candidate"], {
  AUTHORING_SDK_TARBALL: sdkInput.absoluteFile,
  AUTHORING_CANDIDATE_DIR: apiClientProofRoot,
});
const apiClientProofPath = path.join(
  apiClientProofRoot,
  "api-client-authoring-candidate-receipt.json",
);
const apiClientProof = JSON.parse(
  await readFile(apiClientProofPath, "utf8"),
) as ApiClientProof;
assertApiClientProof(apiClientProof, sdkInput.integrity);
const apiClientTarballSource = path.join(
  apiClientProofRoot,
  apiClientProof.package.tarball,
);
const apiClientTarballFile = path.basename(apiClientTarballSource);
const retainedApiClientProofFile =
  "api-client-authoring-candidate-receipt.json";
await rename(
  apiClientTarballSource,
  path.join(outputRoot, apiClientTarballFile),
);
await rename(
  apiClientProofPath,
  path.join(outputRoot, retainedApiClientProofFile),
);
await rm(apiClientProofRoot, { recursive: true, force: true });

const packages = await Promise.all([
  apiClientPackage(apiClientProof, apiClientTarballFile),
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
  sdkInput: {
    name: sdkInput.name,
    version: sdkInput.version,
    file: sdkInput.file,
    registryTarball: sdkInput.registryTarball,
    integrity: sdkInput.integrity,
  },
  apiClientProof: {
    file: retainedApiClientProofFile,
    integrity: integrityFor(
      await readFile(path.join(outputRoot, retainedApiClientProofFile)),
    ),
  },
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

async function run(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<void> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}

async function downloadSdkInput(): Promise<{
  name: string;
  version: string;
  file: string;
  absoluteFile: string;
  registryTarball: string;
  integrity: string;
}> {
  const { name, version } = AUTHORING_RELEASE_SET.packages.sdk;
  const metadataResponse = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (!metadataResponse.ok) {
    throw new Error(
      `Unable to resolve immutable SDK input ${name}@${version}: npm returned ${metadataResponse.status}.`,
    );
  }
  const metadata = (await metadataResponse.json()) as RegistryVersionMetadata;
  const registryTarball = metadata.dist?.tarball;
  const integrity = metadata.dist?.integrity;
  if (!registryTarball || !integrity?.startsWith("sha512-")) {
    throw new Error(`${name}@${version} registry metadata is incomplete.`);
  }
  const tarballResponse = await fetch(registryTarball);
  if (!tarballResponse.ok) {
    throw new Error(
      `Unable to download ${name}@${version}: registry returned ${tarballResponse.status}.`,
    );
  }
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const actualIntegrity = integrityFor(bytes);
  if (actualIntegrity !== integrity) {
    throw new Error(
      `${name}@${version} registry tarball integrity mismatch: expected ${integrity}, received ${actualIntegrity}.`,
    );
  }
  const file = path.join("inputs", `dreamboard-games-sdk-${version}.tgz`);
  const absoluteFile = path.join(outputRoot, file);
  await mkdir(path.dirname(absoluteFile), { recursive: true });
  await writeFile(absoluteFile, bytes);
  return {
    name,
    version,
    file,
    absoluteFile,
    registryTarball,
    integrity,
  };
}

function assertApiClientProof(
  proof: ApiClientProof,
  sdkIntegrity: string,
): void {
  const expectedApiClient = AUTHORING_RELEASE_SET.packages.apiClient;
  const expectedSdk = AUTHORING_RELEASE_SET.packages.sdk;
  if (
    proof.schemaVersion !== 1 ||
    proof.package.name !== expectedApiClient.name ||
    proof.package.version !== expectedApiClient.version ||
    proof.sdkInput.name !== expectedSdk.name ||
    proof.sdkInput.version !== expectedSdk.version ||
    proof.sdkInput.integrity !== sdkIntegrity
  ) {
    throw new Error(
      "API-client packed conformance proof does not match the authoring release set and immutable SDK input.",
    );
  }
}

async function apiClientPackage(
  proof: ApiClientProof,
  file: string,
): Promise<AuthoringReleaseCandidatePackageV1> {
  const bytes = await readFile(path.join(outputRoot, file));
  const shasum = createHash("sha1").update(bytes).digest("hex");
  return {
    key: "apiClient",
    name: proof.package.name,
    version: proof.package.version,
    file,
    integrity: proof.package.integrity,
    shasum,
  };
}

function integrityFor(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
