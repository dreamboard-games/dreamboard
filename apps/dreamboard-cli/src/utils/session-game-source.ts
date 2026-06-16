import type { SessionGameSource } from "@dreamboard-games/api-client";

export function projectIdFromSessionGameSource(
  source: SessionGameSource,
): string {
  if (source.kind === "USER_COMPILED") {
    return source.projectId;
  }

  return `demo:${source.slug}:${source.revisionId}`;
}
