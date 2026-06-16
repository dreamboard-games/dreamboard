export type RefreshErrorKind = "permanent_invalid" | "transient" | "unknown";

export type ClassifiedRefreshError = {
  kind: RefreshErrorKind;
  reason?: string;
};

export function classifyRefreshError(error: {
  message?: string;
  status?: number;
}): ClassifiedRefreshError {
  const message = error.message?.toLowerCase() ?? "";
  if (
    error.status === 400 ||
    error.status === 401 ||
    message.includes("invalid_grant") ||
    message.includes("refresh token") ||
    message.includes("expired") ||
    message.includes("revoked")
  ) {
    return { kind: "permanent_invalid", reason: error.message };
  }
  if (
    error.status === 408 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500) ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return { kind: "transient", reason: error.message };
  }
  return { kind: "unknown", reason: error.message };
}
