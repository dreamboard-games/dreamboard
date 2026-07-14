import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertCandidateFileIntegrity,
  assertReceiptFileIntegrity,
  candidatePackage,
  DEFAULT_CANDIDATE_ROOT,
  optionValue,
  readCandidateReceipt,
} from "./authoring-release-candidate.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const receiptPath = path.resolve(
  optionValue(
    process.argv.slice(2),
    "--candidate",
    path.join(DEFAULT_CANDIDATE_ROOT, "receipt.json"),
  ),
);
const receipt = await readCandidateReceipt(receiptPath);
const cli = candidatePackage(receipt, "cli");
const devHost = candidatePackage(receipt, "devHost");
const apiClient = candidatePackage(receipt, "apiClient");
const cliTarball = await assertCandidateFileIntegrity(receiptPath, cli);
const devHostTarball = await assertCandidateFileIntegrity(receiptPath, devHost);
const apiClientTarball = await assertCandidateFileIntegrity(
  receiptPath,
  apiClient,
);
const sdkTarball = await assertReceiptFileIntegrity(
  receiptPath,
  receipt.sdkInput,
  "SDK input",
);
const apiClientProofPath = await assertReceiptFileIntegrity(
  receiptPath,
  receipt.apiClientProof,
  "API-client proof",
);
const apiClientProof = JSON.parse(
  await readFile(apiClientProofPath, "utf8"),
) as {
  package?: { name?: string; version?: string; integrity?: string };
  sdkInput?: { name?: string; version?: string; integrity?: string };
  packedRuntime?: { sdkName?: string; sdkVersion?: string };
};
if (
  apiClientProof.package?.name !== apiClient.name ||
  apiClientProof.package.version !== apiClient.version ||
  apiClientProof.package.integrity !== apiClient.integrity ||
  apiClientProof.sdkInput?.name !== receipt.sdkInput.name ||
  apiClientProof.sdkInput.version !== receipt.sdkInput.version ||
  apiClientProof.sdkInput.integrity !== receipt.sdkInput.integrity ||
  apiClientProof.packedRuntime?.sdkName !== receipt.sdkInput.name ||
  apiClientProof.packedRuntime.sdkVersion !== receipt.sdkInput.version
) {
  throw new Error(
    "API-client packed conformance proof does not match the candidate package and SDK input.",
  );
}

await run(
  "pnpm",
  ["--dir", "apps/dreamboard-cli", "run", "test:package"],
  repoRoot,
);

const consumerRoot = await mkdtemp(
  path.join(os.tmpdir(), "dreamboard-release-candidate-"),
);
try {
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        packageManager: receipt.releaseSet.packageManager,
        pnpm: {
          overrides: {
            [apiClient.name]: `file:${apiClientTarball}`,
            [receipt.sdkInput.name]: `file:${sdkTarball}`,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await run(
    "pnpm",
    [
      "add",
      `file:${apiClientTarball}`,
      `file:${devHostTarball}`,
      `file:${cliTarball}`,
      `file:${sdkTarball}`,
      "--ignore-workspace",
      "--config.shared-workspace-lockfile=false",
      "--config.strict-peer-dependencies=true",
    ],
    consumerRoot,
  );
  await run("pnpm", ["exec", "dreamboard", "--help"], consumerRoot);

  const installedDevHost = JSON.parse(
    await readFile(
      path.join(
        consumerRoot,
        "node_modules/@dreamboard-games/dev-host/package.json",
      ),
      "utf8",
    ),
  ) as { peerDependencies?: Record<string, string> };
  if (
    installedDevHost.peerDependencies?.["@dreamboard-games/sdk"] !==
    receipt.releaseSet.packages.sdk.version
  ) {
    throw new Error(
      "Installed dev-host SDK peer does not match the release set.",
    );
  }
  const installedApiClient = JSON.parse(
    await readFile(
      path.join(
        consumerRoot,
        "node_modules/@dreamboard-games/api-client/package.json",
      ),
      "utf8",
    ),
  ) as { version?: string };
  if (installedApiClient.version !== apiClient.version) {
    throw new Error(
      "Installed API client does not match the immutable release candidate.",
    );
  }
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}

console.log(`authoring release candidate verified from ${receiptPath}`);

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
}
