import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

export type TypeScriptModuleSourceClosure = {
  readonly bundleText: string;
  readonly sourceDigest: string;
  readonly inputs: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
};

type SourceClosureBuildResult = Awaited<ReturnType<typeof build>>;

/**
 * Bundle a project-local TypeScript entry and bind it to its canonical local
 * module closure. Absolute checkout paths and bundled sourcemaps are excluded
 * from the digest, so the same committed tree has the same identity in a
 * working copy and a detached exact-commit worktree.
 *
 * External package identity is intentionally not folded into sourceDigest;
 * callers bind the installed package version/integrity separately.
 */
export async function bundleTypeScriptModuleWithSourceClosure(
  entryPath: string,
  options: {
    readonly projectRoot: string;
    readonly external?: readonly string[];
  },
): Promise<TypeScriptModuleSourceClosure> {
  const sourceCheckoutContext = resolveSourceCheckoutBuildContext();
  const projectRoot = path.resolve(options.projectRoot);
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: [path.resolve(entryPath)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: "inline",
    external: [...ESBUILD_EXTERNALS, ...(options.external ?? [])],
    nodePaths: sourceCheckoutContext.nodePaths,
    plugins: sourceCheckoutContext.plugins,
    metafile: true,
    write: false,
  });

  const output = result.outputFiles?.[0];
  if (!output || !result.metafile) {
    throw new Error(`Failed to bundle TypeScript module '${entryPath}'.`);
  }

  return sourceClosureFromBuild({ result, projectRoot });
}

/** Bundle a synthetic local entry without writing it into the game tree. */
export async function bundleTypeScriptSourceWithSourceClosure(options: {
  readonly source: string;
  readonly projectRoot: string;
  readonly sourcefile?: string;
  readonly external?: readonly string[];
}): Promise<TypeScriptModuleSourceClosure> {
  const sourceCheckoutContext = resolveSourceCheckoutBuildContext();
  const projectRoot = path.resolve(options.projectRoot);
  const sourcefile = options.sourcefile ?? "__dreamboard_scenario_entry__.ts";
  const result = await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: options.source,
      loader: "ts",
      resolveDir: projectRoot,
      sourcefile,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    sourcemap: "inline",
    external: [...ESBUILD_EXTERNALS, ...(options.external ?? [])],
    nodePaths: sourceCheckoutContext.nodePaths,
    plugins: sourceCheckoutContext.plugins,
    metafile: true,
    write: false,
  });

  return sourceClosureFromBuild({
    result,
    projectRoot,
    excludedInputs: new Set([path.resolve(projectRoot, sourcefile)]),
  });
}

async function sourceClosureFromBuild(options: {
  readonly result: SourceClosureBuildResult;
  readonly projectRoot: string;
  readonly excludedInputs?: ReadonlySet<string>;
}): Promise<TypeScriptModuleSourceClosure> {
  const output = options.result.outputFiles?.[0];
  if (!output || !options.result.metafile) {
    throw new Error("Failed to bundle TypeScript module source closure.");
  }
  const inputPaths = Object.keys(options.result.metafile.inputs)
    .map((inputPath) =>
      path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(options.projectRoot, inputPath),
    )
    .filter(
      (inputPath) =>
        !options.excludedInputs?.has(inputPath) &&
        isProjectLocalInput(options.projectRoot, inputPath),
    );
  const inputs = await Promise.all(
    inputPaths.map(async (inputPath) => {
      const content = await readFile(inputPath);
      return {
        path: toPosixPath(path.relative(options.projectRoot, inputPath)),
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const sourceDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        digestVersion: "dreamboard-scenario-source-closure@1",
        inputs,
      }),
    )
    .digest("hex")}`;

  return {
    bundleText: output.text,
    sourceDigest,
    inputs,
  };
}

function isProjectLocalInput(projectRoot: string, inputPath: string): boolean {
  const relative = path.relative(projectRoot, inputPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return !relative.split(path.sep).includes("node_modules");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function importTypeScriptModule<T>(entryPath: string): Promise<T> {
  return importBundledTypeScriptModuleText<T>(
    await bundleTypeScriptModuleText(entryPath),
    path.basename(entryPath).replace(/\.[^.]+$/u, ""),
  );
}

export async function importBundledTypeScriptModuleText<T>(
  bundleText: string,
  moduleName = "module",
): Promise<T> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "dreamboard-ts-module-"));
  const outfile = path.join(tempDir, `${moduleName}.mjs`);

  try {
    await writeFile(outfile, bundleText);

    return (await import(pathToFileURL(outfile).href)) as T;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
