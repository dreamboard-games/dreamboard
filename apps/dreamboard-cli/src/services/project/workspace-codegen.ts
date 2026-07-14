import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import { loadProjectAuthoringAdapter } from "../project-authoring/loader.js";
import { validateGeneratedArtifacts } from "../project-authoring/validation.js";
import {
  readWorkspaceTextFileIfExists,
  writeWorkspaceTextFile,
} from "./workspace-path.js";

export interface WorkspaceCodegenWriteResult {
  written: string[];
  skipped: string[];
  merged: string[];
}

const STARTER_UI_SEED_FILES = new Set([
  "ui/interaction-routes.tsx",
  "ui/setup-screen.tsx",
  "ui/styles.ts",
  "ui/ui-contract-typing-smoke.tsx",
]);
const SETUP_PROFILES_SEED_MARKER = "Dreamboard generated setup profile seeds.";

function isFrameworkOwnedSetupProfilesSeed(
  content: string | null | undefined,
): boolean {
  if (content === null || content === undefined) {
    return false;
  }
  const trimmed = content.trim();
  return trimmed.length === 0 || trimmed.includes(SETUP_PROFILES_SEED_MARKER);
}

export async function applyWorkspaceCodegen(options: {
  projectRoot: string;
  manifest: GameTopologyManifest;
}): Promise<WorkspaceCodegenWriteResult> {
  const { projectRoot, manifest } = options;
  const { adapter } = await loadProjectAuthoringAdapter(projectRoot);
  const artifacts = validateGeneratedArtifacts(
    adapter,
    adapter.generateWorkspaceArtifacts(manifest),
  );
  const authoritativeFiles = new Map(
    artifacts
      .filter((artifact) => artifact.ownership !== "seed")
      .map((artifact) => [artifact.path, artifact.content]),
  );
  const seedFiles = new Map(
    artifacts
      .filter((artifact) => artifact.ownership === "seed")
      .map((artifact) => [artifact.path, artifact.content]),
  );

  const written: string[] = [];
  const skipped: string[] = [];
  const merged: string[] = [];
  const existingUiAppBeforeSeeds = await readWorkspaceTextFileIfExists(
    projectRoot,
    "ui/App.tsx",
  );
  const shouldWriteStarterUiSeedFiles =
    existingUiAppBeforeSeeds === null ||
    existingUiAppBeforeSeeds.trim().length === 0;

  for (const [relativePath, content] of authoritativeFiles) {
    const existingContent = await readWorkspaceTextFileIfExists(
      projectRoot,
      relativePath,
    );
    await writeWorkspaceTextFile(projectRoot, relativePath, content);
    if (existingContent !== content) {
      written.push(relativePath);
    }
  }

  for (const [relativePath, content] of seedFiles) {
    const existingContent = await readWorkspaceTextFileIfExists(
      projectRoot,
      relativePath,
    );
    if (
      STARTER_UI_SEED_FILES.has(relativePath) &&
      !shouldWriteStarterUiSeedFiles &&
      existingContent === null
    ) {
      skipped.push(relativePath);
      continue;
    }

    const shouldRefreshFrameworkSeed =
      relativePath === "app/setup-profiles.ts" &&
      isFrameworkOwnedSetupProfilesSeed(existingContent);

    if (shouldRefreshFrameworkSeed) {
      await writeWorkspaceTextFile(projectRoot, relativePath, content);
      if (existingContent !== content) {
        written.push(relativePath);
      }
      continue;
    }

    const hasExistingContent =
      existingContent !== null && existingContent.trim().length > 0;
    if (hasExistingContent) {
      skipped.push(relativePath);
      continue;
    }

    await writeWorkspaceTextFile(projectRoot, relativePath, content);
    written.push(relativePath);
  }

  written.sort();
  skipped.sort();
  merged.sort();
  return { written, skipped, merged };
}
