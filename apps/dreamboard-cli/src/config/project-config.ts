import path from "node:path";
import type {
  LegacyProjectConfigV1,
  ProjectConfig,
  ProjectEnvironmentBindingV1,
  ProjectEnvironmentStateV1,
  ProjectManifestV2,
} from "../types.js";
import {
  PROJECT_DIR_NAME,
  PROJECT_CONFIG_FILE,
  PROJECT_STATE_FILE,
} from "../constants.js";
import { ensureDir, exists, readJsonFile } from "../utils/fs.js";
import { atomicWriteFile } from "../utils/atomic-file.js";

const LEGACY_DEFAULT_DEPLOYMENT_ID = "legacy";
const LEGACY_DEFAULT_OWNER_SCOPE_ID = "default";
const LEGACY_DEFAULT_BINDING_KEY = `${LEGACY_DEFAULT_DEPLOYMENT_ID}:${LEGACY_DEFAULT_OWNER_SCOPE_ID}`;

function normalizeProjectManifest(config: ProjectConfig): ProjectManifestV2 {
  return {
    schemaVersion: 2,
    projectId: config.projectId,
    slug: config.slug,
  };
}

function normalizeProjectBinding(
  config: ProjectConfig,
): ProjectEnvironmentBindingV1 {
  return {
    deploymentId: config.deploymentId ?? LEGACY_DEFAULT_DEPLOYMENT_ID,
    ownerScopeId: config.ownerScopeId ?? LEGACY_DEFAULT_OWNER_SCOPE_ID,
    gameId: config.gameId,
    remoteHeadDigest: config.remoteHeadDigest,
    jobId: config.jobId,
    agentManaged: config.agentManaged,
    workspacePrepared: config.workspacePrepared,
    allowCreateGame: config.allowCreateGame,
    environment: config.environment,
    authoring: config.authoring,
    compile: config.compile,
    localMaintainerRegistry: config.localMaintainerRegistry,
    apiBaseUrl: config.apiBaseUrl,
    webBaseUrl: config.webBaseUrl,
    packageManifest: config.packageManifest,
    environmentManifest: config.environmentManifest,
  };
}

function normalizeProjectState(
  config: ProjectConfig,
  existing?: ProjectEnvironmentStateV1,
): ProjectEnvironmentStateV1 {
  const binding = normalizeProjectBinding(config);
  const bindingKey =
    config.bindingKey || `${binding.deploymentId}:${binding.ownerScopeId}`;
  return {
    schemaVersion: 1,
    bindings: {
      ...(existing?.bindings ?? {}),
      [bindingKey]: binding,
    },
  };
}

function mergeManifestAndBinding(
  manifest: ProjectManifestV2,
  binding: ProjectEnvironmentBindingV1 | undefined,
  bindingKey: string | undefined,
): ProjectConfig {
  return {
    ...manifest,
    ...(binding ?? {
      deploymentId: LEGACY_DEFAULT_DEPLOYMENT_ID,
      ownerScopeId: LEGACY_DEFAULT_OWNER_SCOPE_ID,
    }),
    gameId: binding?.gameId ?? manifest.projectId,
    bindingKey:
      bindingKey ??
      `${binding?.deploymentId ?? LEGACY_DEFAULT_DEPLOYMENT_ID}:${
        binding?.ownerScopeId ?? LEGACY_DEFAULT_OWNER_SCOPE_ID
      }`,
  };
}

function isProjectManifestV2(value: unknown): value is ProjectManifestV2 {
  const candidate = value as Partial<ProjectManifestV2>;
  return (
    candidate?.schemaVersion === 2 &&
    typeof candidate.projectId === "string" &&
    typeof candidate.slug === "string"
  );
}

function normalizeLegacyProjectConfig(
  config: LegacyProjectConfigV1 & { projectId?: string },
): ProjectConfig {
  return {
    schemaVersion: 2,
    projectId: config.projectId ?? config.gameId,
    slug: config.slug,
    bindingKey: LEGACY_DEFAULT_BINDING_KEY,
    deploymentId: LEGACY_DEFAULT_DEPLOYMENT_ID,
    ownerScopeId: LEGACY_DEFAULT_OWNER_SCOPE_ID,
    gameId: config.gameId,
    jobId: config.jobId,
    agentManaged: config.agentManaged,
    workspacePrepared: config.workspacePrepared,
    allowCreateGame: config.allowCreateGame,
    environment: config.environment,
    authoring: config.authoring,
    compile: config.compile,
    localMaintainerRegistry: config.localMaintainerRegistry,
    apiBaseUrl: config.apiBaseUrl,
    webBaseUrl: config.webBaseUrl,
    packageManifest: config.packageManifest,
    environmentManifest: config.environmentManifest,
  };
}

async function loadProjectEnvironmentState(
  rootDir: string,
): Promise<ProjectEnvironmentStateV1> {
  const filePath = path.join(rootDir, PROJECT_DIR_NAME, PROJECT_STATE_FILE);
  if (!(await exists(filePath))) {
    return { schemaVersion: 1, bindings: {} };
  }
  const state = await readJsonFile<ProjectEnvironmentStateV1>(filePath);
  return state.schemaVersion === 1 && state.bindings
    ? state
    : { schemaVersion: 1, bindings: {} };
}

export async function loadProjectConfig(
  rootDir: string,
): Promise<ProjectConfig> {
  const filePath = path.join(rootDir, PROJECT_DIR_NAME, PROJECT_CONFIG_FILE);
  const rawConfig = await readJsonFile<ProjectManifestV2 | LegacyProjectConfigV1>(
    filePath,
  );
  if (!isProjectManifestV2(rawConfig)) {
    const migrated = normalizeLegacyProjectConfig(
      rawConfig as LegacyProjectConfigV1,
    );
    await updateProjectState(rootDir, migrated);
    return migrated;
  }

  const state = await loadProjectEnvironmentState(rootDir);
  const entries = Object.entries(state.bindings);
  const [bindingKey, binding] =
    entries.find(([key]) => key !== LEGACY_DEFAULT_BINDING_KEY) ??
    entries.find(([key]) => key === LEGACY_DEFAULT_BINDING_KEY) ??
    [];
  return mergeManifestAndBinding(rawConfig, binding, bindingKey);
}

export async function updateProjectState(
  rootDir: string,
  config: ProjectConfig,
): Promise<void> {
  const dir = path.join(rootDir, PROJECT_DIR_NAME);
  await ensureDir(dir);
  const existingState = await loadProjectEnvironmentState(rootDir);
  await atomicWriteFile(
    path.join(dir, PROJECT_CONFIG_FILE),
    `${JSON.stringify(normalizeProjectManifest(config), null, 2)}\n`,
    { mode: 0o644 },
  );
  await atomicWriteFile(
    path.join(dir, PROJECT_STATE_FILE),
    `${JSON.stringify(normalizeProjectState(config, existingState), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function updateProjectEnvironmentState(
  rootDir: string,
  config: ProjectConfig,
): Promise<void> {
  const dir = path.join(rootDir, PROJECT_DIR_NAME);
  await ensureDir(dir);
  const existingState = await loadProjectEnvironmentState(rootDir);
  await atomicWriteFile(
    path.join(dir, PROJECT_STATE_FILE),
    `${JSON.stringify(normalizeProjectState(config, existingState), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function findProjectRoot(
  startDir: string,
): Promise<string | null> {
  let current = path.resolve(startDir);
  for (let i = 0; i < 25; i++) {
    const candidate = path.join(current, PROJECT_DIR_NAME, PROJECT_CONFIG_FILE);
    if (await exists(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
