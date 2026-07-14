#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const stageRoot = path.join(packageRoot, ".publish", "package");
const sourceSkillRoot = path.join(repoRoot, "skills", "dreamboard");
const stagedSkillRoot = path.join(stageRoot, "skills", "dreamboard");

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

const sourcePackage = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const packageJson = { ...sourcePackage };
delete packageJson.scripts;

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(sourceSkillRoot, stagedSkillRoot, { recursive: true, force: true });

const readmePath = path.join(packageRoot, "README.md");
if (await pathExists(readmePath)) {
  await cp(readmePath, path.join(stageRoot, "README.md"), { force: true });
}

await writeFile(
  path.join(stageRoot, "package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
  "utf8",
);

console.log(`staged ${packageJson.name}@${packageJson.version}`);
