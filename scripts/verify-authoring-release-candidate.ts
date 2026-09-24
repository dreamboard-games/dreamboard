import {
  validateCandidateCohort,
  type PackageManifest,
} from "./release-candidate-validation.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
const destination = path.resolve(
  import.meta.dirname,
  "../build/release-candidate",
);
const receipt = JSON.parse(
  await readFile(path.join(destination, "receipt.json"), "utf8"),
);
if (receipt.schemaVersion !== 2 || receipt.packages.length !== 2)
  throw new Error("Expected browser runtime and offline dev host candidate");
const manifests: PackageManifest[] = [];
for (const entry of receipt.packages) {
  const file = path.join(destination, entry.file);
  const bytes = await readFile(file);
  if (
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
    entry.integrity
  )
    throw new Error(`Integrity mismatch: ${entry.name}`);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", file, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  manifests.push(manifest);
  const listing = execFileSync("tar", ["-tf", file], { encoding: "utf8" });
  if (!listing.includes("package/dist/index.js"))
    throw new Error("Missing entrypoint");
  if (
    entry.name === "@dreamboard-games/dev-host" &&
    !listing.includes("package/dist/cli.js")
  )
    throw new Error("Missing launcher");
}
validateCandidateCohort(receipt, manifests);
console.log(
  "Verified offline package identities, compiled entrypoints, and sha512 integrity.",
);
