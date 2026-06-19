import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliCoreRoot = path.join(repoRoot, "packages", "cli-core");
const forbiddenCliCoreDependencies = [
  "citty",
  "consola",
  "vite",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "tailwindcss",
  "@tailwindcss/postcss",
  "postcss",
  "playwright",
  "@dreamboard-games/ui-host-runtime",
];

const packageJson = JSON.parse(
  await readFile(path.join(cliCoreRoot, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const packageViolations = dependencyFields.flatMap((field) => {
  const values = packageJson[field] ?? {};
  return forbiddenCliCoreDependencies
    .filter((dependency) => dependency in values)
    .map((dependency) => `${field}.${dependency}`);
});

const importViolations: string[] = [];
for (const entry of await findTypeScriptFiles(path.join(cliCoreRoot, "src"))) {
  const relativeEntry = path.relative(cliCoreRoot, entry);
  const content = await readFile(entry, "utf8");
  for (const dependency of forbiddenCliCoreDependencies) {
    const quotedImport = new RegExp(
      String.raw`from\s+["']${escapeRegex(dependency)}(?:/[^"']*)?["']|import\(["']${escapeRegex(dependency)}(?:/[^"']*)?["']\)`,
    );
    if (quotedImport.test(content)) {
      importViolations.push(`${relativeEntry}: imports ${dependency}`);
    }
  }
}

const violations = [...packageViolations, ...importViolations];
if (violations.length > 0) {
  throw new Error(
    `@dreamboard-games/cli-core crossed its dependency boundary:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`,
  );
}

console.log("@dreamboard-games/cli-core dependency boundary passed.");

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return findTypeScriptFiles(entryPath);
      }
      return entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
}
