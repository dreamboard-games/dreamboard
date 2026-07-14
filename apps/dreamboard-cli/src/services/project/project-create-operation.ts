import os from "node:os";
import path from "node:path";
import { PROJECT_DIR_NAME } from "../../constants.js";
import { atomicWriteFile, withFileLock } from "../../utils/atomic-file.js";
import { readJsonFile } from "../../utils/fs.js";
import { hashContent } from "../../utils/crypto.js";
import { createUuidV7 } from "../../utils/uuid-v7.js";
import {
  contextualizeCliError,
  type CliOperationContext,
  type ProjectCreateStep,
} from "../../utils/errors.js";

type OperationState = "not_started" | "attempted" | "confirmed";
type OperationStateKey =
  | "remoteProjectState"
  | "repositoryState"
  | "workspaceState"
  | "gitState";

type ProjectCreateOperationSnapshot = {
  schemaVersion: 1;
  operationId: string;
  command: "project.create";
  environment: "local" | "staging" | "prod";
  apiBaseUrl: string;
  slug: string;
  projectId: string;
  targetDir: string;
  remoteProjectState: OperationState;
  repositoryState: OperationState;
  workspaceState: OperationState;
  gitState: OperationState;
  updatedAt: string;
};

type OpenProjectCreateOperationOptions = {
  environment: "local" | "staging" | "prod";
  apiBaseUrl: string;
  slug: string;
  targetDir: string;
};

function getOperationDir(): string {
  return path.join(os.homedir(), PROJECT_DIR_NAME, "operations", "project-create");
}

function getOperationPath(options: {
  environment: string;
  slug: string;
}): string {
  const key = hashContent(`${options.environment}\0${options.slug}`);
  return path.join(getOperationDir(), `${options.environment}-${key}.json`);
}

function isState(value: unknown): value is OperationState {
  return (
    value === "not_started" || value === "attempted" || value === "confirmed"
  );
}

function parseSnapshot(
  value: unknown,
): ProjectCreateOperationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.command !== "project.create" ||
    typeof candidate.operationId !== "string" ||
    (candidate.environment !== "local" &&
      candidate.environment !== "staging" &&
      candidate.environment !== "prod") ||
    typeof candidate.apiBaseUrl !== "string" ||
    typeof candidate.slug !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.targetDir !== "string" ||
    !isState(candidate.remoteProjectState) ||
    !isState(candidate.repositoryState) ||
    !isState(candidate.workspaceState) ||
    !isState(candidate.gitState) ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return candidate as ProjectCreateOperationSnapshot;
}

function createSnapshot(
  options: OpenProjectCreateOperationOptions,
): ProjectCreateOperationSnapshot {
  return {
    schemaVersion: 1,
    operationId: createUuidV7(),
    command: "project.create",
    environment: options.environment,
    apiBaseUrl: options.apiBaseUrl,
    slug: options.slug,
    projectId: createUuidV7(),
    targetDir: options.targetDir,
    remoteProjectState: "not_started",
    repositoryState: "not_started",
    workspaceState: "not_started",
    gitState: "not_started",
    updatedAt: new Date().toISOString(),
  };
}

export class ProjectCreateOperation {
  private constructor(
    private readonly journalPath: string,
    private snapshot: ProjectCreateOperationSnapshot,
  ) {}

  static async open(
    options: OpenProjectCreateOperationOptions,
  ): Promise<ProjectCreateOperation> {
    const journalPath = getOperationPath(options);
    const lockPath = `${journalPath}.lock`;
    const snapshot = await withFileLock(lockPath, async () => {
      const existing = await readJsonFile<unknown>(journalPath)
        .then(parseSnapshot)
        .catch(() => null);
      if (
        existing &&
        existing.environment === options.environment &&
        existing.slug === options.slug
      ) {
        const updated: ProjectCreateOperationSnapshot = {
          ...existing,
          apiBaseUrl: options.apiBaseUrl,
          targetDir: options.targetDir,
          updatedAt: new Date().toISOString(),
        };
        await writeSnapshot(journalPath, updated);
        return updated;
      }
      const created = createSnapshot(options);
      await writeSnapshot(journalPath, created);
      return created;
    });
    return new ProjectCreateOperation(journalPath, snapshot);
  }

  get projectId(): string {
    return this.snapshot.projectId;
  }

  async markAttempted(key: OperationStateKey): Promise<void> {
    await this.updateState(key, "attempted");
  }

  async markConfirmed(key: OperationStateKey): Promise<void> {
    await this.updateState(key, "confirmed");
  }

  async run<T>(step: ProjectCreateStep, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw contextualizeCliError(error, this.context(step));
    }
  }

  private async updateState(
    key: OperationStateKey,
    state: OperationState,
  ): Promise<void> {
    this.snapshot = {
      ...this.snapshot,
      [key]: state,
      updatedAt: new Date().toISOString(),
    };
    await writeSnapshot(this.journalPath, this.snapshot);
  }

  private context(step: ProjectCreateStep): CliOperationContext {
    const { schemaVersion: _schemaVersion, updatedAt: _updatedAt, ...context } =
      this.snapshot;
    return {
      ...context,
      step,
    };
  }
}

async function writeSnapshot(
  journalPath: string,
  snapshot: ProjectCreateOperationSnapshot,
): Promise<void> {
  await atomicWriteFile(journalPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}
