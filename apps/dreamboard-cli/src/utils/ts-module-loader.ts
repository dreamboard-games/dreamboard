import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolveCliRepoRoot } from "./repo-root.js";
import { createRepoLocalPackageResolutionPlugin } from "./repo-local-package-resolution.js";

const ESBUILD_EXTERNALS = [
  "playwright",
  "playwright-core",
  "chromium-bidi",
  "electron",
];

function resolveSourceCheckoutBuildContext(): {
  nodePaths: string[];
  plugins: ReturnType<typeof createRepoLocalPackageResolutionPlugin>[];
} {
  try {
    const repoRoot = resolveCliRepoRoot(import.meta.url);
    return {
      nodePaths: [
        path.join(repoRoot, "apps", "dreamboard-cli", "node_modules"),
        path.join(repoRoot, "node_modules"),
      ],
      plugins: [createRepoLocalPackageResolutionPlugin({ repoRoot })],
    };
  } catch {
    return {
      nodePaths: [path.join(process.cwd(), "node_modules")],
      plugins: [],
    };
  }
}

export async function bundleTypeScriptModuleText(
  entryPath: string,
  options: { external?: readonly string[] } = {},
): Promise<string> {
  const sourceCheckoutContext = resolveSourceCheckoutBuildContext();
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: "inline",
    external: [...ESBUILD_EXTERNALS, ...(options.external ?? [])],
    nodePaths: sourceCheckoutContext.nodePaths,
    plugins: sourceCheckoutContext.plugins,
    write: false,
  });

  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error(`Failed to bundle TypeScript module '${entryPath}'.`);
  }
  return output.text;
}

export async function importTypeScriptModule<T>(entryPath: string): Promise<T> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "dreamboard-ts-module-"));
  const outfile = path.join(
    tempDir,
    `${path.basename(entryPath).replace(/\.[^.]+$/u, "")}.mjs`,
  );

  try {
    const bundledText = await bundleTypeScriptModuleText(entryPath);
    await writeFile(outfile, bundledText);

    return (await import(pathToFileURL(outfile).href)) as T;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
