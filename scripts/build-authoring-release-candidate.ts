import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Commit source changes before producing a release receipt");
const destination = path.join(root, "build/release-candidate");
await mkdir(destination, { recursive: true });
const sdkVersion = JSON.parse(
  await readFile(
    path.join(root, "packages/browser-gameplay-runtime/package.json"),
    "utf8",
  ),
).dependencies["@dreamboard-games/sdk"];
const packages = [];
for (const directory of ["browser-gameplay-runtime", "dev-host"]) {
  const cwd = path.join(root, "packages", directory);
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd,
    stdio: "inherit",
  });
  const manifest = JSON.parse(
    await readFile(path.join(cwd, "package.json"), "utf8"),
  );
  const file = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
  const bytes = await readFile(path.join(destination, file));
  packages.push({
    name: manifest.name,
    version: manifest.version,
    file,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}
await writeFile(
  path.join(destination, "receipt.json"),
  JSON.stringify(
    {
      schemaVersion: 2,
      sdkVersion,
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      packages,
    },
    null,
    2,
  ) + "\n",
);
