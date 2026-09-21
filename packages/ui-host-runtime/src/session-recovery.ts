export interface SessionRecoveryDetails {
  message: string;
  retryAfterMs: number;
}

const DEFAULT_RECOVERY_RETRY_AFTER_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseRetryAfterMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getProblemPayload(error: unknown): Record<string, unknown> | null {
  const direct = asRecord(error);
  if (!direct) {
    return null;
  }
  if (typeof direct.title === "string" && typeof direct.status === "number") {
    return direct;
  }
  for (const key of ["error", "data", "body", "cause"]) {
    const nested = asRecord(direct[key]);
    if (
      nested &&
      typeof nested.title === "string" &&
      typeof nested.status === "number"
    ) {
      return nested;
    }
  }
  return null;
}

export function getSessionRecoveryDetails(
  error: unknown,
): SessionRecoveryDetails | null {
  const problem = getProblemPayload(error);
  if (problem) {
    const title = typeof problem.title === "string" ? problem.title : "";
    const detail = typeof problem.detail === "string" ? problem.detail : "";
    const retryable = problem.retryable === true;
    const isRecovery =
      problem.status === 503 &&
      retryable &&
      (title === "Session recovering" ||
        detail.toLowerCase().includes("recovering"));
    if (!isRecovery) {
      return null;
    }
    const context = asRecord(problem.context);
    return {
      message:
        detail.trim() || "Session state is recovering. Retrying shortly.",
      retryAfterMs:
        parseRetryAfterMs(context?.retryAfterMs) ??
        DEFAULT_RECOVERY_RETRY_AFTER_MS,
    };
  }

  if (error instanceof Error && /Live failed:\s*503\b/i.test(error.message)) {
    return {
      message: "Session state is recovering. Retrying shortly.",
      retryAfterMs: DEFAULT_RECOVERY_RETRY_AFTER_MS,
    };
  }

  return null;
}
