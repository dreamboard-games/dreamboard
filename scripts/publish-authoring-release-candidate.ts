import { validateInstalledProof } from "./release-candidate-validation.ts";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import "./verify-authoring-release-candidate.ts";
const destination = path.resolve(
  import.meta.dirname,
  "../build/release-candidate",
);
const receipt = JSON.parse(
  await readFile(path.join(destination, "receipt.json"), "utf8"),
);
validateInstalledProof(
  receipt,
  JSON.parse(
    await readFile(path.join(destination, "installed-proof.json"), "utf8"),
  ),
);
if (
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !==
  receipt.sourceCommit
)
  throw new Error(
    "Publication checkout must match the verified candidate source commit",
  );
const tag = process.env.NPM_TAG;
if (!tag || !["alpha", "beta", "latest"].includes(tag))
  throw new Error("NPM_TAG must be alpha, beta, or latest");
if (tag !== "alpha" && process.env.GITHUB_REF_NAME !== "main")
  throw new Error("Non-main branches may publish only alpha releases");
function registryIntegrity(name: string, version: string): string | null {
  try {
    return JSON.parse(
      execFileSync(
        "npm",
        [
          "view",
          `${name}@${version}`,
          "dist.integrity",
          "--json",
          "--registry",
          "https://registry.npmjs.org/",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) {
      const body = JSON.parse(stdout);
      if (body.error?.code === "E404") return null;
    }
    throw error;
  }
}
const unpublished = [];
for (const entry of receipt.packages) {
  const existing = registryIntegrity(entry.name, entry.version);
  if (existing === null) unpublished.push(entry);
  else if (existing !== entry.integrity)
    throw new Error(
      `${entry.name}@${entry.version} already exists with different bytes`,
    );
}
for (const entry of unpublished) {
  execFileSync(
    "npm",
    [
      "publish",
      path.join(destination, entry.file),
      "--tag",
      tag,
      "--provenance",
      "--registry",
      "https://registry.npmjs.org/",
    ],
    { stdio: "inherit" },
  );
}
for (const entry of receipt.packages) {
  if (registryIntegrity(entry.name, entry.version) !== entry.integrity)
    throw new Error(`Published integrity mismatch: ${entry.name}`);
}
