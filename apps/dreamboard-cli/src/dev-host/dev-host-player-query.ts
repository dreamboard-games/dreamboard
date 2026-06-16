export function normalizeDevHostPlayerQueryParam(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("player-") ? trimmed : `player-${trimmed}`;
}

export function resolveInitialDevHostPlayerId(
  search: string | URLSearchParams,
): string | null {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  return normalizeDevHostPlayerQueryParam(params.get("player"));
}
