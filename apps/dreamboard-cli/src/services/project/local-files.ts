import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import {
  PROJECT_DIR_NAME,
  MANIFEST_FILE,
  RULE_FILE,
  SNAPSHOT_FILE,
  LOCAL_IGNORE_DIRS,
} from "../../constants.js";
import type { Snapshot } from "../../types.js";
import {
  readJsonFile,
  readTextFile,
  readTextFileIfExists,
  writeTextFile,
} from "../../utils/fs.js";
import { atomicWriteFile } from "../../utils/atomic-file.js";
import { hashContent } from "../../utils/crypto.js";
import {
  computeManifestHash,
  materializeManifest,
  writeManifestSource,
} from "./manifest-authoring.js";
import {
  isAllowedGamePath as isAllowedPathFromOwnership,
  isDynamicGeneratedPath,
  isLibraryPath as isLibraryPathFromOwnership,
} from "./scaffold-ownership.js";

/**
 * Returns true when a path is inside the canonical game project structure.
 * Anything outside app/, ui/, shared/, or the known root files is rejected.
 */
export function isAllowedGamePath(filePath: string): boolean {
  return isAllowedPathFromOwnership(filePath);
}

export function isLibraryPath(filePath: string): boolean {
  return isLibraryPathFromOwnership(filePath);
}

type WriteDecision = "write" | "skip";

/**
 * Decide whether a file from the scaffold response should be written to disk.
 *
 * - Library files     → always overwrite (they are fully generated).
 * - Everything else   → only write if the file does not yet exist or is empty
 *                        locally (first-time seeding; preserves user edits).
 */
function shouldWriteScaffoldFile(
  filePath: string,
  existingContent: string | null,
): WriteDecision {
  if (isLibraryPath(filePath)) return "write";
  const hasContent =
    existingContent !== null && existingContent.trim().length > 0;
  return hasContent ? "skip" : "write";
}

export async function writeSourceFiles(
  rootDir: string,
  files: Record<string, string | null>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    if (content === null || content === undefined) continue;
    const filePath = path.join(rootDir, relativePath);
    await writeTextFile(filePath, content);
  }
}

export interface ScaffoldWriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Write scaffold files using local-merge logic.
 *
 * - Library files are always overwritten.
 * - User-owned files (phases, components, etc.) are only written when the
 *   local file does not exist or is empty.  Files with content are skipped
 *   so user edits are never lost.
 *
 * Returns lists of files that were written (and actually changed) and files
 * that were skipped because a non-empty local copy already exists.
 */
export async function writeScaffoldFiles(
  rootDir: string,
  files: Record<string, string | null>,
): Promise<ScaffoldWriteResult> {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const [relativePath, content] of Object.entries(files)) {
    if (content === null || content === undefined) continue;

    const fullPath = path.join(rootDir, relativePath);
    const existingContent = await readTextFileIfExists(fullPath);

    const decision = shouldWriteScaffoldFile(relativePath, existingContent);

    if (decision === "skip") {
      skipped.push(relativePath);
      continue;
    }

    await writeTextFile(fullPath, content);

    if (existingContent !== content) {
      written.push(relativePath);
    }
  }

  written.sort();
  skipped.sort();
  return { written, skipped };
}

export async function removeExtraneousFiles(
  rootDir: string,
  keep: Set<string>,
): Promise<void> {
  const localFiles = await collectLocalFiles(rootDir);
  for (const filePath of Object.keys(localFiles)) {
    if (filePath === MANIFEST_FILE || filePath === RULE_FILE) continue;
    if (!keep.has(filePath)) {
      await unlink(path.join(rootDir, filePath));
    }
  }
}

export async function collectLocalFiles(
  rootDir: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await walkDir(rootDir, rootDir, result);
  return result;
}

export async function walkDir(
  rootDir: string,
  currentDir: string,
  result: Record<string, string>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (LOCAL_IGNORE_DIRS.has(entry.name)) continue;
      await walkDir(rootDir, path.join(currentDir, entry.name), result);
    } else if (entry.isFile()) {
      const filePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, filePath);
      result[relativePath] = await readTextFile(filePath);
    }
  }
}

export async function writeManifest(
  rootDir: string,
  manifest: GameTopologyManifest,
): Promise<void> {
  await writeManifestSource(rootDir, manifest);
}

export async function writeRule(
  rootDir: string,
  ruleText: string,
): Promise<void> {
  const filePath = path.join(rootDir, RULE_FILE);
  await writeTextFile(filePath, ruleText);
}

export async function loadManifest(
  rootDir: string,
): Promise<GameTopologyManifest> {
  return materializeManifest(rootDir);
}

export { computeManifestHash };

export async function loadRule(rootDir: string): Promise<string> {
  const filePath = path.join(rootDir, RULE_FILE);
  return readTextFile(filePath);
}

export async function writeSnapshot(rootDir: string): Promise<void> {
  const files = await collectLocalFiles(rootDir);
  await writeSnapshotFromFiles(rootDir, files);
}

export async function writeSnapshotFromFiles(
  rootDir: string,
  files: Record<string, string>,
): Promise<void> {
  const snapshot: Snapshot = {
    files: {},
  };

  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.startsWith(`${PROJECT_DIR_NAME}/`)) continue;
    if (isDynamicGeneratedPath(filePath)) continue;
    snapshot.files[filePath] = hashContent(content);
  }

  const snapshotPath = path.join(rootDir, PROJECT_DIR_NAME, SNAPSHOT_FILE);
  // Atomic write: a crash mid-snapshot (e.g. user kills a long `dreamboard
  // sync`) must not leave `.dreamboard/snapshot.json` truncated, or
  // `getLocalDiff` will silently report everything as "added" on the
  // next run and force a full re-sync.
  await atomicWriteFile(
    snapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: 0o644 },
  );
}

function isIgnorableLocalDiffPath(filePath: string): boolean {
  return (
    filePath.startsWith("test/generated/") ||
    filePath.startsWith(".playwright-cli/")
  );
}

export async function getLocalDiff(rootDir: string): Promise<{
  modified: string[];
  added: string[];
  deleted: string[];
}> {
  const snapshotPath = path.join(rootDir, PROJECT_DIR_NAME, SNAPSHOT_FILE);
  const snapshot = await readJsonFile<Snapshot>(snapshotPath).catch(() => null);
  if (!snapshot) {
    return { modified: [], added: [], deleted: [] };
  }

  const files = await collectLocalFiles(rootDir);
  const currentHashes: Record<string, string> = {};

  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.startsWith(`${PROJECT_DIR_NAME}/`)) continue;
    if (isIgnorableLocalDiffPath(filePath)) continue;
    if (isDynamicGeneratedPath(filePath)) continue;
    currentHashes[filePath] = hashContent(content);
  }

  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  for (const [filePath, hash] of Object.entries(currentHashes)) {
    const prevHash = snapshot.files[filePath];
    if (!prevHash) {
      added.push(filePath);
    } else if (prevHash !== hash) {
      modified.push(filePath);
    }
  }

  for (const filePath of Object.keys(snapshot.files)) {
    if (isIgnorableLocalDiffPath(filePath)) continue;
    if (isDynamicGeneratedPath(filePath)) continue;
    if (!currentHashes[filePath]) {
      deleted.push(filePath);
    }
  }

  return { modified, added, deleted };
}
