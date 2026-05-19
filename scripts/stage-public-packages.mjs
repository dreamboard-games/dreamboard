import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = path.join(repoRoot, ".publish", "packages");
const publicRegistryUrl = "https://github.com/dreamboard-games/dreamboard.git";
const publicHomepage = "http://dreamboard.games/";
const publicBugsUrl = "https://github.com/dreamboard-games/dreamboard/issues";
const sourceScope = "@dreamboard/";
const publishScope = "@dreamboard-games/";

const publicPackageDirs = [
  "packages/api-client",
  "packages/sdk-types",
  "packages/reducer-contract",
  "packages/app-sdk",
  "packages/ui-sdk",
  "packages/testing",
  "packages/workspace-codegen",
];

const packageJsonByDir = new Map();
for (const dir of publicPackageDirs) {
  const packageJson = await readJson(path.join(repoRoot, dir, "package.json"));
  packageJsonByDir.set(dir, packageJson);
}

const publicPackages = new Map(
  [...packageJsonByDir.values()].map((packageJson) => [
    packageJson.name,
    {
      publishedName: toPublishedPackageName(packageJson.name),
      version: packageJson.version,
    },
  ]),
);

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });

for (const dir of publicPackageDirs) {
  const sourceDir = path.join(repoRoot, dir);
  const sourcePackageJson = packageJsonByDir.get(dir);
  const packageFiles = await resolvePackageFiles(sourceDir, sourcePackageJson);
  const packageJson = normalizePackageJson(sourcePackageJson, packageFiles);
  const targetDir = path.join(stageRoot, packageSlug(packageJson.name));

  await mkdir(targetDir, { recursive: true });
  for (const entry of packageFiles) {
    await copyIfPresent(path.join(sourceDir, entry), path.join(targetDir, entry));
  }
  await copyIfPresent(path.join(repoRoot, "LICENSE"), path.join(targetDir, "LICENSE"));
  await copyIfPresent(path.join(repoRoot, "NOTICE"), path.join(targetDir, "NOTICE"));
  await writeFile(
    path.join(targetDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
}

async function resolvePackageFiles(sourceDir, sourcePackageJson) {
  const entries = new Set(sourcePackageJson.files ?? []);
  for (const candidate of ["dist", "src", "schema", "generated", "fixtures", "ownership.json"]) {
    if (await exists(path.join(sourceDir, candidate))) {
      entries.add(candidate);
    }
  }
  entries.add("README.md");
  entries.add("LICENSE");
  entries.add("NOTICE");
  return [...entries];
}

function normalizePackageJson(sourcePackageJson, packageFiles) {
  const packageJson = structuredClone(sourcePackageJson);
  packageJson.name = toPublishedPackageName(sourcePackageJson.name);
  delete packageJson.private;
  delete packageJson.devDependencies;
  packageJson.license = "SEE LICENSE IN LICENSE";
  packageJson.publishConfig = { access: "public" };
  packageJson.repository = {
    type: "git",
    url: publicRegistryUrl,
  };
  packageJson.homepage = publicHomepage;
  packageJson.bugs = { url: publicBugsUrl };
  packageJson.files = packageFiles;

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (!packageJson[field]) continue;
    packageJson[field] = rewriteDependencyMap(packageJson[field]);
  }

  return packageJson;
}

function rewriteDependencyMap(dependencies) {
  const rewritten = {};
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (publicPackages.has(name)) {
      const publicPackage = publicPackages.get(name);
      rewritten[name] = `npm:${publicPackage.publishedName}@${publicPackage.version}`;
    } else if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
      throw new Error(`Cannot publish unresolved workspace dependency ${name}`);
    } else {
      rewritten[name] = specifier;
    }
  }
  return rewritten;
}

function toPublishedPackageName(packageName) {
  if (!packageName.startsWith(sourceScope)) {
    return packageName;
  }
  return `${publishScope}${packageName.slice(sourceScope.length)}`;
}

function packageSlug(packageName) {
  return packageName.replace(/^@/, "").replace("/", "__");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function copyIfPresent(sourcePath, targetPath) {
  if (!(await exists(sourcePath))) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true, force: true });
}

async function exists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}
