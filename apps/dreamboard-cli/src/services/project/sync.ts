import path from "node:path";
import type { GameTopologyManifest } from "@dreamboard-games/api-client";
import { MANIFEST_FILE, RULE_FILE } from "../../constants.js";
import type { ProjectConfig, ResolvedConfig } from "../../types.js";
import { updateProjectState } from "../../config/project-config.js";
import {
  getProjectRevisionSourcesSdk,
  getProjectSourcesSdk,
} from "../api/project-api.js";
import {
  clearProjectPendingAuthoringSync,
  updateProjectAuthoringState,
} from "./project-state.js";
import { exists } from "../../utils/fs.js";
import {
  collectLocalFiles,
  removeExtraneousFiles,
  loadManifest,
  writeManifest,
  writeRule,
  writeSnapshot,
  writeSourceFiles,
} from "./local-files.js";
import { isAllowedGamePath, isLibraryPath } from "./scaffold-ownership.js";
import { applyWorkspaceCodegen } from "./workspace-codegen.js";
import { installWorkspaceDependencies } from "./workspace-dependencies.js";
import {
  unlinkWorkspaceFile,
  workspacePathExists,
  writeWorkspaceTextFile,
} from "./workspace-path.js";

const META_FILES = new Set([RULE_FILE]);
const LOCAL_PACKAGE_METADATA_FILES = new Set([
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
]);

export type RemoteProjectSources = {
  authoringStateId?: string;
  revisionDigest?: string;
  files: Record<string, string>;
  sourceRevisionId: string;
  treeHash: string;
  manifestId?: string;
  manifestContentHash?: string;
  manifest?: GameTopologyManifest;
  ruleId?: string;
  ruleText?: string;
};

export type RemoteReconcileResult = {
  latest: RemoteProjectSources;
  remoteUserFiles: Record<string, string>;
  written: string[];
  deleted: string[];
  conflicts: string[];
};

function normalizeRemoteFiles(
  response:
    | {
        files?: Record<string, string>;
        sourceFiles?: Record<string, string>;
      }
    | undefined,
): Record<string, string> {
  return response?.files ?? response?.sourceFiles ?? {};
}

function isMergeablePath(filePath: string): boolean {
  if (META_FILES.has(filePath)) return true;
  return isAllowedGamePath(filePath) && !isLibraryPath(filePath);
}

function isMergeableUserPath(filePath: string): boolean {
  return (
    !META_FILES.has(filePath) &&
    isAllowedGamePath(filePath) &&
    !isLibraryPath(filePath)
  );
}

function buildMergeableRemoteFiles(
  sources: RemoteProjectSources,
): Record<string, string> {
  const files: Record<string, string> = {};

  for (const [filePath, content] of Object.entries(sources.files)) {
    if (isMergeablePath(filePath)) {
      files[filePath] = content;
    }
  }

  if (typeof sources.ruleText === "string") {
    files[RULE_FILE] = sources.ruleText;
  }

  return files;
}

function formatConflictSection(content: string | null): string {
  if (content === null) return "";
  return content.endsWith("\n") ? content : `${content}\n`;
}

function buildConflictContent(
  localContent: string | null,
  remoteContent: string | null,
): string {
  return [
    "<<<<<<< LOCAL",
    formatConflictSection(localContent),
    "=======",
    formatConflictSection(remoteContent),
    ">>>>>>> REMOTE",
    "",
  ].join("\n");
}

function mergeFileContent(options: {
  baseContent: string | null;
  localContent: string | null;
  remoteContent: string | null;
}): { content: string | null; conflicted: boolean } {
  const { baseContent, localContent, remoteContent } = options;

  if (localContent === remoteContent) {
    return { content: localContent, conflicted: false };
  }

  if (baseContent === localContent) {
    return { content: remoteContent, conflicted: false };
  }

  if (baseContent === remoteContent) {
    return { content: localContent, conflicted: false };
  }

  if (baseContent === null) {
    if (localContent === null) {
      return { content: remoteContent, conflicted: false };
    }
    if (remoteContent === null) {
      return { content: localContent, conflicted: false };
    }
    return {
      content: buildConflictContent(localContent, remoteContent),
      conflicted: true,
    };
  }

  if (localContent === null) {
    if (remoteContent === null) {
      return { content: null, conflicted: false };
    }
    return {
      content: buildConflictContent(null, remoteContent),
      conflicted: true,
    };
  }

  if (remoteContent === null) {
    return {
      content: buildConflictContent(localContent, null),
      conflicted: true,
    };
  }

  return {
    content: buildConflictContent(localContent, remoteContent),
    conflicted: true,
  };
}

async function fetchRemoteRevisionSources(
  projectId: string,
  revisionDigest: string,
): Promise<RemoteProjectSources> {
  const sources = await getProjectRevisionSourcesSdk({
    projectId,
    revisionDigest,
  });

  return {
    revisionDigest: sources.revisionDigest,
    files: normalizeRemoteFiles(sources),
    sourceRevisionId: sources.sourceRevisionId,
    treeHash: sources.sourceTreeHash,
    manifestContentHash: sources.manifestContentHash,
    manifest: sources.manifest,
    ruleText: sources.ruleText,
  };
}

export async function fetchLatestRemoteSources(
  gameId: string,
): Promise<RemoteProjectSources | null> {
  void gameId;
  throw new Error("Legacy game source fetch is no longer supported.");
}

export async function fetchLatestRemoteProjectSources(
  projectId: string,
): Promise<RemoteProjectSources | null> {
  const sources = await getProjectSourcesSdk(projectId);
  if (!sources) {
    return null;
  }
  return {
    authoringStateId: sources.revisionDigest,
    revisionDigest: sources.revisionDigest,
    files: normalizeRemoteFiles(sources),
    sourceRevisionId: sources.sourceRevisionId,
    treeHash: sources.treeHash,
    manifestContentHash: sources.manifestContentHash ?? undefined,
    manifest: sources.manifest,
    ruleText: sources.ruleText,
  };
}

export async function pullIntoDirectory(
  config: ResolvedConfig,
  targetDir: string,
  projectConfig: ProjectConfig,
): Promise<ProjectConfig> {
  const latest = await fetchLatestRemoteProjectSources(projectConfig.projectId);
  if (!latest) {
    throw new Error("No authoring state found for this game.");
  }

  await writeSourceFiles(targetDir, latest.files);
  await removeExtraneousFiles(targetDir, new Set(Object.keys(latest.files)));

  if (latest.manifest && !latest.files[MANIFEST_FILE]) {
    await writeManifest(targetDir, latest.manifest);
  }

  if (typeof latest.ruleText === "string") {
    await writeRule(targetDir, latest.ruleText);
  }

  if (await exists(path.join(targetDir, "package.json"))) {
    await installWorkspaceDependencies(targetDir);
  }

  const manifestForCodegen = await loadManifest(targetDir);
  await applyWorkspaceCodegen({
    projectRoot: targetDir,
    manifest: manifestForCodegen,
  });

  const pulledProjectConfig = buildPulledProjectConfig(
    config,
    projectConfig,
    latest,
  );
  await updateProjectState(targetDir, pulledProjectConfig);

  await writeSnapshot(targetDir);
  return pulledProjectConfig;
}

export function buildPulledProjectConfig(
  config: Pick<ResolvedConfig, "apiBaseUrl" | "webBaseUrl">,
  projectConfig: ProjectConfig,
  latest: RemoteProjectSources,
): ProjectConfig {
  return updateProjectAuthoringState(
    clearProjectPendingAuthoringSync({
      ...projectConfig,
      remoteHeadDigest: latest.revisionDigest ?? projectConfig.remoteHeadDigest,
      apiBaseUrl: projectConfig.apiBaseUrl ?? config.apiBaseUrl,
      webBaseUrl: projectConfig.webBaseUrl ?? config.webBaseUrl,
    }),
    {
      revisionDigest: latest.revisionDigest ?? projectConfig.remoteHeadDigest,
      authoringStateId: latest.authoringStateId,
      sourceRevisionId: latest.sourceRevisionId,
      sourceTreeHash: latest.treeHash,
      manifestId: latest.manifestId ?? projectConfig.authoring?.manifestId,
      manifestContentHash:
        latest.manifestContentHash ??
        projectConfig.authoring?.manifestContentHash,
      ruleId: latest.ruleId ?? projectConfig.authoring?.ruleId,
    },
  );
}

export async function reconcileRemoteChangesIntoWorkspace(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  baseRevisionDigest: string;
  latestRevisionDigest: string;
}): Promise<RemoteReconcileResult> {
  const {
    projectRoot,
    projectConfig,
    baseRevisionDigest,
    latestRevisionDigest,
  } = options;
  const [base, latest, localFiles] = await Promise.all([
    fetchRemoteRevisionSources(projectConfig.projectId, baseRevisionDigest),
    fetchRemoteRevisionSources(projectConfig.projectId, latestRevisionDigest),
    collectLocalFiles(projectRoot),
  ]);

  const baseFiles = buildMergeableRemoteFiles(base);
  const latestFiles = buildMergeableRemoteFiles(latest);
  const localMergeableFiles = Object.fromEntries(
    Object.entries(localFiles).filter(([filePath]) =>
      isMergeablePath(filePath),
    ),
  );

  const candidatePaths = new Set<string>([
    ...Object.keys(baseFiles),
    ...Object.keys(latestFiles),
    ...Object.keys(localMergeableFiles),
  ]);

  const written: string[] = [];
  const deleted: string[] = [];
  const conflicts: string[] = [];

  for (const filePath of [...candidatePaths].sort()) {
    const mergeResult = mergeFileContent({
      baseContent: baseFiles[filePath] ?? null,
      localContent: localMergeableFiles[filePath] ?? null,
      remoteContent: latestFiles[filePath] ?? null,
    });

    if (mergeResult.content === null) {
      if (await workspacePathExists(projectRoot, filePath)) {
        await unlinkWorkspaceFile(projectRoot, filePath);
        deleted.push(filePath);
      }
      continue;
    }

    await writeWorkspaceTextFile(projectRoot, filePath, mergeResult.content);
    written.push(filePath);

    if (mergeResult.conflicted) {
      conflicts.push(filePath);
    }
  }

  return {
    latest,
    remoteUserFiles: Object.fromEntries(
      Object.entries(latest.files).filter(([filePath]) =>
        isMergeableUserPath(filePath),
      ),
    ),
    written,
    deleted,
    conflicts,
  };
}

export function buildRemoteAlignedSnapshotFiles(options: {
  localFiles: Record<string, string>;
  remoteUserFiles: Record<string, string>;
}): Record<string, string> {
  const snapshotFiles = {
    ...options.localFiles,
    ...options.remoteUserFiles,
  };

  for (const filePath of LOCAL_PACKAGE_METADATA_FILES) {
    if (options.localFiles[filePath] !== undefined) {
      snapshotFiles[filePath] = options.localFiles[filePath];
    }
  }

  return snapshotFiles;
}
