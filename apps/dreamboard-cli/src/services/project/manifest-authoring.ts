import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { zGameTopologyManifest } from "@dreamboard-games/api-client";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import { MANIFEST_FILE, MATERIALIZED_MANIFEST_FILE } from "../../constants.js";
import { createRepoLocalPackageResolutionPlugin } from "../../utils/repo-local-package-resolution.js";
import { hashContent } from "../../utils/crypto.js";
import { loadProjectAuthoringAdapter } from "../project-authoring/loader.js";
import {
  readWorkspaceTextFile,
  workspacePathExists,
  writeWorkspaceJsonFile,
  writeWorkspaceTextFile,
} from "./workspace-path.js";

function formatIssuePath(pathSegments: ReadonlyArray<string | number>): string {
  if (pathSegments.length === 0) {
    return "manifest";
  }

  return `manifest${pathSegments
    .map((segment) =>
      typeof segment === "number" ? `[${segment}]` : `.${segment}`,
    )
    .join("")}`;
}

async function formatManifestValidationError(
  projectRoot: string,
  manifest: unknown,
): Promise<string> {
  const parsedManifest = zGameTopologyManifest.strict().safeParse(manifest);
  if (!parsedManifest.success) {
    const lines = parsedManifest.error.issues.map((issue) => {
      const issuePath = formatIssuePath(
        issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      );
      return `${issuePath}: ${issue.message}`;
    });

    return `Invalid manifest:\n- ${lines.join("\n- ")}`;
  }

  const { adapter } = await loadProjectAuthoringAdapter(projectRoot);
  const validationResult = adapter.validateManifest(
    parsedManifest.data as GameTopologyManifest,
  );
  if (validationResult.errors.length > 0) {
    return `Invalid manifest:\n- ${validationResult.errors.join("\n- ")}`;
  }
  if (validationResult.warnings.length > 0) {
    console.warn(
      `Manifest warnings:\n- ${validationResult.warnings.join("\n- ")}`,
    );
  }

  return "";
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonKeys(item)]),
    );
  }

  return value;
}

export function computeManifestHash(manifest: GameTopologyManifest): string {
  return hashContent(JSON.stringify(sortJsonKeys(manifest)));
}

async function evaluateManifestSource(
  projectRoot: string,
): Promise<GameTopologyManifest> {
  if (!(await workspacePathExists(projectRoot, MANIFEST_FILE))) {
    throw new Error(`Missing ${MANIFEST_FILE}.`);
  }

  let outputText: string | undefined;
  try {
    const buildResult = await build({
      absWorkingDir: projectRoot,
      entryPoints: [MANIFEST_FILE],
      bundle: true,
      format: "esm",
      platform: "node",
      target: ["node24"],
      write: false,
      logLevel: "silent",
      plugins: [createRepoLocalPackageResolutionPlugin()],
    });
    outputText = buildResult.outputFiles[0]?.text;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown bundle failure";
    throw new Error(`Failed to evaluate ${MANIFEST_FILE}: ${message}`);
  }

  if (!outputText) {
    throw new Error(
      `Failed to evaluate ${MANIFEST_FILE}: no bundled module was produced.`,
    );
  }

  let moduleRecord: { default?: unknown };
  const tempRoot = await mkdtemp(path.join(tmpdir(), "dreamboard-manifest-"));
  const bundlePath = path.join(tempRoot, "manifest.mjs");
  try {
    await writeFile(bundlePath, outputText, "utf8");
    moduleRecord = (await import(
      `${pathToFileURL(bundlePath).href}?t=${Date.now()}`
    )) as {
      default?: unknown;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to evaluate ${MANIFEST_FILE}: ${message}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  if (moduleRecord.default === undefined) {
    throw new Error(
      `${MANIFEST_FILE} must default-export defineTopologyManifest(...).`,
    );
  }

  const validationError = await formatManifestValidationError(
    projectRoot,
    moduleRecord.default,
  );
  if (validationError) {
    throw new Error(validationError);
  }

  return moduleRecord.default as GameTopologyManifest;
}

export function renderManifestSource(manifest: GameTopologyManifest): string {
  return [
    'import { defineTopologyManifest } from "@dreamboard-games/sdk/types";',
    "",
    "export default defineTopologyManifest(",
    `${JSON.stringify(manifest, null, 2)}`,
    ");",
    "",
  ].join("\n");
}

export async function materializeManifest(
  projectRoot: string,
): Promise<GameTopologyManifest> {
  const manifest = await evaluateManifestSource(projectRoot);
  await writeWorkspaceJsonFile(
    projectRoot,
    MATERIALIZED_MANIFEST_FILE,
    manifest,
  );
  return manifest;
}

export async function readMaterializedManifestText(
  projectRoot: string,
): Promise<string> {
  await materializeManifest(projectRoot);
  return readWorkspaceTextFile(projectRoot, MATERIALIZED_MANIFEST_FILE);
}

export async function writeManifestSource(
  projectRoot: string,
  manifest: GameTopologyManifest,
): Promise<void> {
  await writeWorkspaceTextFile(
    projectRoot,
    MANIFEST_FILE,
    renderManifestSource(manifest),
  );
  await writeWorkspaceJsonFile(
    projectRoot,
    MATERIALIZED_MANIFEST_FILE,
    manifest,
  );
}
