import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertCandidateFileIntegrity,
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
const cliTarball = await assertCandidateFileIntegrity(receiptPath, cli);
const devHostTarball = await assertCandidateFileIntegrity(receiptPath, devHost);

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
      `file:${devHostTarball}`,
      `file:${cliTarball}`,
      `${receipt.releaseSet.packages.sdk.name}@${receipt.releaseSet.packages.sdk.version}`,
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
