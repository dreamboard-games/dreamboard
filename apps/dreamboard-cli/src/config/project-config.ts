import path from "node:path";
import type {
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
    deploymentId: config.deploymentId,
    ownerScopeId: config.ownerScopeId,
    remoteHeadDigest: config.remoteHeadDigest,
    jobId: config.jobId,
    agentManaged: config.agentManaged,
    workspacePrepared: config.workspacePrepared,
    allowCreateGame: config.allowCreateGame,
    environment: config.environment,
    authoring: config.authoring,
    compile: config.compile,
    apiBaseUrl: config.apiBaseUrl,
    webBaseUrl: config.webBaseUrl,
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
  if (!binding) {
    throw new Error(
      "Project state is missing an environment binding. Recreate or reclone the project.",
    );
  }
  return {
    ...manifest,
    ...binding,
    bindingKey: bindingKey ?? `${binding.deploymentId}:${binding.ownerScopeId}`,
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
  const rawConfig = await readJsonFile<ProjectManifestV2>(filePath);
  if (!isProjectManifestV2(rawConfig)) {
    throw new Error(
      `Unsupported project config at ${filePath}. Expected schemaVersion 2 with projectId and slug.`,
    );
  }

  const state = await loadProjectEnvironmentState(rootDir);
  const entries = Object.entries(state.bindings);
  const [bindingKey, binding] = entries[0] ?? [];
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
