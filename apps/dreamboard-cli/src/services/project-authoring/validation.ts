import path from "node:path";
import { createHash } from "node:crypto";
import {
  ProjectAuthoringError,
  type GeneratedArtifactV1,
  type ProjectAuthoringAdapterV1,
} from "./contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidGeneratedPath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\")
  ) {
    return false;
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath) {
    return false;
  }
  return !relativePath
    .split("/")
    .some((segment) => segment.length === 0 || segment === "." || segment === "..");
}

const ALLOWED_GENERATED_PREFIXES = [
  "app/",
  "shared/",
  "test/generated/",
  "ui/",
] as const;

function isAllowedGeneratedPath(relativePath: string): boolean {
  return ALLOWED_GENERATED_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

function assertGeneratedPath(pathValue: unknown, label: string): string {
  if (
    typeof pathValue !== "string" ||
    !isValidGeneratedPath(pathValue) ||
    !isAllowedGeneratedPath(pathValue)
  ) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      `${label} must be a normalized relative workspace path.`,
    );
  }
  return pathValue;
}

function assertGeneratedArtifact(value: unknown): GeneratedArtifactV1 {
  if (!isRecord(value)) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      "Generated artifact must be an object.",
    );
  }
  const artifactPath = assertGeneratedPath(value.path, "Generated artifact path");
  if (
    value.ownership !== "authoritative" &&
    value.ownership !== "seed" &&
    value.ownership !== "derived-test"
  ) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      `Generated artifact '${artifactPath}' has invalid ownership.`,
    );
  }
  if (typeof value.content !== "string") {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      `Generated artifact '${artifactPath}' content must be a string.`,
    );
  }
  const expectedHash = createHash("sha256")
    .update(value.content)
    .digest("hex");
  if (value.contentSha256 !== expectedHash) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      `Generated artifact '${artifactPath}' has a stale content hash.`,
    );
  }
  return value as GeneratedArtifactV1;
}

export function validateProjectAuthoringAdapter(
  adapter: unknown,
): ProjectAuthoringAdapterV1 {
  if (!isRecord(adapter)) {
    throw new ProjectAuthoringError(
      "AUTHORING_PROTOCOL_UNSUPPORTED",
      "SDK authoring export did not provide an adapter object.",
    );
  }
  if (adapter.protocolVersion !== 1) {
    throw new ProjectAuthoringError(
      "AUTHORING_PROTOCOL_UNSUPPORTED",
      `Unsupported SDK authoring protocol '${String(adapter.protocolVersion)}'.`,
    );
  }
  if (!isRecord(adapter.metadata)) {
    throw new ProjectAuthoringError(
      "AUTHORING_PROTOCOL_UNSUPPORTED",
      "SDK authoring adapter metadata is missing.",
    );
  }
  for (const key of [
    "sdkVersion",
    "codegenVersion",
    "manifestSchemaVersion",
    "generatedArtifactSchemaVersion",
  ] as const) {
    if (
      adapter.metadata[key] === undefined ||
      (key.endsWith("Version") && typeof adapter.metadata[key] !== "string" && typeof adapter.metadata[key] !== "number")
    ) {
      throw new ProjectAuthoringError(
        "AUTHORING_PROTOCOL_UNSUPPORTED",
        `SDK authoring adapter metadata '${key}' is missing.`,
      );
    }
  }
  for (const method of [
    "validateManifest",
    "materializeManifest",
    "generateWorkspaceArtifacts",
    "generateTestArtifacts",
  ] as const) {
    if (typeof adapter[method] !== "function") {
      throw new ProjectAuthoringError(
        "AUTHORING_PROTOCOL_UNSUPPORTED",
        `SDK authoring adapter method '${method}' is missing.`,
      );
    }
  }
  if (!Array.isArray(adapter.generatedPaths)) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      "SDK authoring adapter generatedPaths must be an array.",
    );
  }
  const seen = new Set<string>();
  for (const [index, generatedPath] of adapter.generatedPaths.entries()) {
    const normalized = assertGeneratedPath(
      generatedPath,
      `generatedPaths[${index}]`,
    );
    if (seen.has(normalized)) {
      throw new ProjectAuthoringError(
        "GENERATED_PATH_CONTRACT_INVALID",
        `Generated path '${normalized}' is declared more than once.`,
      );
    }
    seen.add(normalized);
  }
  if (
    adapter.generatedPathPatterns !== undefined &&
    !Array.isArray(adapter.generatedPathPatterns)
  ) {
    throw new ProjectAuthoringError(
      "GENERATED_PATH_CONTRACT_INVALID",
      "SDK authoring adapter generatedPathPatterns must be an array.",
    );
  }
  for (const [index, pattern] of (
    adapter.generatedPathPatterns ?? []
  ).entries()) {
    if (
      !isRecord(pattern) ||
      typeof pattern.prefix !== "string" ||
      typeof pattern.suffix !== "string" ||
      !isValidGeneratedPath(`${pattern.prefix}placeholder${pattern.suffix}`) ||
      !isAllowedGeneratedPath(`${pattern.prefix}placeholder${pattern.suffix}`)
    ) {
      throw new ProjectAuthoringError(
        "GENERATED_PATH_CONTRACT_INVALID",
        `generatedPathPatterns[${index}] must describe a normalized allowlisted workspace path.`,
      );
    }
  }
  return adapter as ProjectAuthoringAdapterV1;
}

export function validateGeneratedArtifacts(
  adapter: ProjectAuthoringAdapterV1,
  artifacts: readonly unknown[],
): readonly GeneratedArtifactV1[] {
  const seen = new Set<string>();
  const validated = artifacts.map(assertGeneratedArtifact);
  for (const artifact of validated) {
    if (seen.has(artifact.path)) {
      throw new ProjectAuthoringError(
        "GENERATED_PATH_CONTRACT_INVALID",
        `Generated artifact path '${artifact.path}' was emitted more than once.`,
      );
    }
    const declared =
      adapter.generatedPaths.includes(artifact.path) ||
      (adapter.generatedPathPatterns ?? []).some(
        (pattern) =>
          artifact.path.startsWith(pattern.prefix) &&
          artifact.path.endsWith(pattern.suffix) &&
          artifact.path.length > pattern.prefix.length + pattern.suffix.length,
      );
    if (!declared) {
      throw new ProjectAuthoringError(
        "GENERATED_PATH_CONTRACT_INVALID",
        `Generated artifact path '${artifact.path}' is not declared by the SDK authoring adapter.`,
      );
    }
    seen.add(artifact.path);
  }
  return validated;
}
