import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

function isWindowsDeviceSegment(segment: string): boolean {
  return WINDOWS_DEVICE_NAME.test(segment.replace(/[. ]+$/g, ""));
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertContained(
  parent: string,
  candidate: string,
  label: string,
): void {
  if (!isPathInside(parent, candidate)) {
    throw new Error(`${label} escapes the workspace.`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function normalizeOwnedProjectPath(input: string): string | null {
  if (
    input.length === 0 ||
    input.trim().length === 0 ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes(":") ||
    URL_SCHEME.test(input) ||
    CONTROL_CHARS.test(input) ||
    ENCODED_SEPARATOR.test(input) ||
    path.win32.isAbsolute(input)
  ) {
    return null;
  }

  const segments = input.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.trim().length === 0 ||
        segment === "." ||
        segment === ".." ||
        isWindowsDeviceSegment(segment),
    )
  ) {
    return null;
  }

  return segments.join("/");
}

export function resolveWorkspacePath(
  rootDir: string,
  projectPath: string,
): string {
  const normalized = normalizeOwnedProjectPath(projectPath);
  if (normalized === null) {
    throw new Error(`Unsafe project path: ${projectPath}`);
  }

  const rootPath = path.resolve(rootDir);
  const resolvedPath = path.resolve(rootPath, normalized);
  assertContained(rootPath, resolvedPath, `Project path ${projectPath}`);
  return resolvedPath;
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function nearestExistingAncestor(filePath: string): Promise<string> {
  let current = filePath;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertRealpathContained(
  rootDir: string,
  filePath: string,
  label: string,
): Promise<void> {
  const rootRealpath = await realpath(rootDir);
  const targetRealpath = await realpath(filePath);
  assertContained(rootRealpath, targetRealpath, label);
}

async function assertNearestParentContained(
  rootDir: string,
  filePath: string,
  label: string,
): Promise<void> {
  const rootRealpath = await realpath(rootDir);
  const nearestParent = await nearestExistingAncestor(path.dirname(filePath));
  const nearestParentRealpath = await realpath(nearestParent);
  assertContained(rootRealpath, nearestParentRealpath, label);
}

async function assertExistingTargetContained(
  rootDir: string,
  filePath: string,
  label: string,
): Promise<void> {
  const targetRealpath = await realpathIfExists(filePath);
  if (targetRealpath === null) return;
  const rootRealpath = await realpath(rootDir);
  assertContained(rootRealpath, targetRealpath, label);
}

async function prepareWorkspaceWriteTarget(
  rootDir: string,
  filePath: string,
): Promise<void> {
  await assertNearestParentContained(rootDir, filePath, "Project path");
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertRealpathContained(
    rootDir,
    path.dirname(filePath),
    "Project path",
  );
  await assertExistingTargetContained(rootDir, filePath, "Project path");
}

export async function readWorkspaceTextFile(
  rootDir: string,
  projectPath: string,
): Promise<string> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  await assertExistingTargetContained(rootDir, filePath, "Project path");
  return readFile(filePath, "utf8");
}

export async function readWorkspaceTextFileIfExists(
  rootDir: string,
  projectPath: string,
): Promise<string | null> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  const targetRealpath = await realpathIfExists(filePath);
  if (targetRealpath === null) return null;
  const rootRealpath = await realpath(rootDir);
  assertContained(rootRealpath, targetRealpath, "Project path");
  return readFile(filePath, "utf8");
}

export async function writeWorkspaceTextFile(
  rootDir: string,
  projectPath: string,
  content: string,
): Promise<void> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  await prepareWorkspaceWriteTarget(rootDir, filePath);
  await writeFile(filePath, content, "utf8");
}

export async function writeWorkspaceJsonFile(
  rootDir: string,
  projectPath: string,
  data: unknown,
): Promise<void> {
  await writeWorkspaceTextFile(
    rootDir,
    projectPath,
    `${JSON.stringify(data, null, 2)}\n`,
  );
}

export async function workspacePathExists(
  rootDir: string,
  projectPath: string,
): Promise<boolean> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  const targetRealpath = await realpathIfExists(filePath);
  if (targetRealpath === null) return false;
  const rootRealpath = await realpath(rootDir);
  assertContained(rootRealpath, targetRealpath, "Project path");
  return true;
}

export async function unlinkWorkspaceFile(
  rootDir: string,
  projectPath: string,
): Promise<void> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  await assertNearestParentContained(rootDir, filePath, "Project path");
  await assertExistingTargetContained(rootDir, filePath, "Project path");
  await unlink(filePath);
}

export async function removeWorkspacePath(
  rootDir: string,
  projectPath: string,
  options: { recursive?: boolean; force?: boolean } = {},
): Promise<void> {
  const filePath = resolveWorkspacePath(rootDir, projectPath);
  await assertNearestParentContained(rootDir, filePath, "Project path");
  await assertExistingTargetContained(rootDir, filePath, "Project path");
  await rm(filePath, options);
}
