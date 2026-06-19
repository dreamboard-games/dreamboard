import type {
  ProblemDetails,
  ProblemViolation,
} from "@dreamboard-games/api-client";
import { zProblemDetails } from "@dreamboard-games/api-client/zod.gen";
import { CLI_PROBLEM_TYPES } from "./problem-types.js";
import type { CliProblemType } from "./problem-types.js";

type ApiClientError =
  | ProblemDetails
  | Error
  | string
  | Record<string, unknown>
  | null
  | undefined;

type ApiProblem = Omit<ProblemDetails, "type"> & {
  type: CliProblemType | (string & {});
};

type CliErrorPresentation = {
  message: string;
  resolution?: string;
  details: string[];
};

export const STALE_CONTRACT_ARTIFACT_CODE = "STALE_CONTRACT_ARTIFACT";
export const STALE_CONTRACT_ARTIFACT_EXIT_CODE = 42;

type ResponseLike = {
  status?: number;
  statusText?: string;
  headers?: {
    get?: (name: string) => string | null | undefined;
  };
};

function isProblemViolationArray(value: unknown): value is ProblemViolation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { message?: unknown }).message === "string",
    )
  );
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  return zProblemDetails.safeParse(value).success;
}

function coerceViolations(value: unknown): ProblemViolation[] | undefined {
  if (isProblemViolationArray(value)) {
    return value;
  }

  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return value.map((message) => ({ message }));
  }

  return undefined;
}

function getRequestId(response?: ResponseLike): string | undefined {
  return (
    response?.headers?.get?.("X-Correlation-ID") ??
    response?.headers?.get?.("x-correlation-id") ??
    undefined
  );
}

export function toApiProblem(
  error: ApiClientError,
  response: ResponseLike | undefined,
  fallback: string,
): ApiProblem {
  if (isProblemDetails(error)) {
    return {
      ...error,
      status: error.status || response?.status || 0,
      requestId: error.requestId ?? getRequestId(response),
    };
  }

  if (error instanceof Error) {
    return {
      type: CLI_PROBLEM_TYPES.TRANSPORT_ERROR,
      title: response?.statusText || "API error",
      status: response?.status ?? 0,
      detail: error.message || fallback,
      requestId: getRequestId(response),
    };
  }

  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const detail =
      typeof obj.detail === "string"
        ? obj.detail
        : typeof obj.message === "string"
          ? obj.message
          : undefined;
    const title =
      typeof obj.title === "string"
        ? obj.title
        : response?.statusText || "API error";
    const violations =
      coerceViolations(obj.violations) ?? coerceViolations(obj.errors);

    if (detail) {
      return {
        type:
          typeof obj.type === "string"
            ? obj.type
            : CLI_PROBLEM_TYPES.UNKNOWN_API_ERROR,
        title,
        status:
          typeof obj.status === "number" ? obj.status : (response?.status ?? 0),
        detail,
        requestId:
          typeof obj.requestId === "string"
            ? obj.requestId
            : getRequestId(response),
        retryable:
          typeof obj.retryable === "boolean" ? obj.retryable : undefined,
        context:
          typeof obj.context === "object" && obj.context !== null
            ? (obj.context as Record<string, string>)
            : undefined,
        violations,
        timestamp:
          typeof obj.timestamp === "string" ? obj.timestamp : undefined,
        instance: typeof obj.instance === "string" ? obj.instance : undefined,
      };
    }
  }

  const detail =
    typeof error === "string" ? error.trim() || fallback : fallback;

  return {
    type: CLI_PROBLEM_TYPES.UNKNOWN_API_ERROR,
    title: response?.statusText || "API error",
    status: response?.status ?? 0,
    detail,
    requestId: getRequestId(response),
  };
}

function formatProblem(problem: ApiProblem): string {
  const base = problem.detail || problem.title;
  const violations =
    problem.violations && problem.violations.length > 0
      ? ` (${problem.violations.map((entry) => entry.message).join("; ")})`
      : "";
  const statusSuffix =
    problem.status && problem.status > 0 ? ` (HTTP ${problem.status})` : "";
  return `${base}${violations}${statusSuffix}`;
}

export class DreamboardApiError extends Error {
  readonly problem: ApiProblem;
  readonly status: number;
  readonly requestId?: string;
  readonly retryable?: boolean;

  constructor(problem: ApiProblem, cause?: unknown) {
    super(formatProblem(problem), { cause });
    this.name = "DreamboardApiError";
    this.problem = problem;
    this.status = problem.status;
    this.requestId = problem.requestId;
    this.retryable = problem.retryable;
  }
}

export function toDreamboardApiError(
  error: ApiClientError,
  response: ResponseLike | undefined,
  fallback: string,
): DreamboardApiError {
  return new DreamboardApiError(toApiProblem(error, response, fallback), error);
}

export function formatApiError(
  error: ApiClientError,
  response: ResponseLike | undefined,
  fallback: string,
): string {
  return formatProblem(toApiProblem(error, response, fallback));
}

export function isDreamboardApiError(
  error: unknown,
): error is DreamboardApiError {
  return error instanceof DreamboardApiError;
}

export function isProblemType(error: unknown, ...types: string[]): boolean {
  return isDreamboardApiError(error) && types.includes(error.problem.type);
}

function getObjectStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  return value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)[property] === "string"
    ? ((value as Record<string, unknown>)[property] as string)
    : undefined;
}

export function isStaleContractArtifactMessage(message: string): boolean {
  return (
    message.includes(STALE_CONTRACT_ARTIFACT_CODE) ||
    message.includes("StaleContractArtifactError") ||
    message.toLowerCase().includes("stale contract artifact")
  );
}

export function isStaleContractArtifactError(error: unknown): boolean {
  if (getObjectStringProperty(error, "code") === STALE_CONTRACT_ARTIFACT_CODE) {
    return true;
  }
  if (getObjectStringProperty(error, "name") === "StaleContractArtifactError") {
    return true;
  }
  const message = getObjectStringProperty(error, "message");
  return message ? isStaleContractArtifactMessage(message) : false;
}

export function getCliErrorExitCode(error: unknown): number {
  return isStaleContractArtifactError(error)
    ? STALE_CONTRACT_ARTIFACT_EXIT_CODE
    : 1;
}

export function getProblemContext(
  error: unknown,
): Record<string, string> | undefined {
  return isDreamboardApiError(error) ? error.problem.context : undefined;
}

export function getProblemContextValue(
  error: unknown,
  key: string,
): string | undefined {
  return getProblemContext(error)?.[key];
}

function isGameNotFoundProblem(problem: ApiProblem): boolean {
  return (
    problem.status === 404 &&
    (problem.detail?.startsWith("Game not found: ") === true ||
      problem.instance?.includes("/source-blobs/upload-sessions") === true)
  );
}

function getProblemResolution(problem: ApiProblem): string | undefined {
  if (isGameNotFoundProblem(problem)) {
    return [
      "Run `dreamboard sync --force` to recreate the remote game state from your current local files if this is a local workspace.",
      "If you meant to use an existing remote game, check that your selected `--env` points at the backend that has that game.",
    ].join(" ");
  }

  switch (problem.type) {
    case CLI_PROBLEM_TYPES.UNAUTHORIZED:
      return "Run `dreamboard auth login` to authenticate again.";
    case CLI_PROBLEM_TYPES.FORBIDDEN:
      return "Check that the signed-in account has access to this game, or run `dreamboard auth login` with the correct account.";
    case CLI_PROBLEM_TYPES.TOO_MANY_REQUESTS:
      return "Wait a moment, then retry the command.";
    case CLI_PROBLEM_TYPES.TRANSPORT_ERROR:
      return "Check that the selected Dreamboard server is reachable and try again later.";
    case CLI_PROBLEM_TYPES.VALIDATION_FAILED:
      return "Fix the validation issue above, then retry the command.";
    case CLI_PROBLEM_TYPES.ACTIVE_JOB_CONFLICT:
      return "Wait for the active job to finish, then retry the command.";
    case CLI_PROBLEM_TYPES.GAME_SLUG_CONFLICT:
      return "Choose a different game slug, or use the existing workspace for that slug.";
    case CLI_PROBLEM_TYPES.SOURCE_REVISION_NOT_FOUND:
      return "Run `dreamboard sync --force` to recreate the remote source revision from your current local files.";
    case CLI_PROBLEM_TYPES.SOURCE_REVISION_DRIFT:
    case CLI_PROBLEM_TYPES.AUTHORING_STATE_DRIFT:
    case CLI_PROBLEM_TYPES.STATE_CONFLICT:
      return "Run `dreamboard pull` to reconcile remote changes before retrying. If this local workspace is the source of truth, rerun the command with `--force` when supported.";
    case CLI_PROBLEM_TYPES.SOURCE_REVISION_BASE_MISSING:
    case CLI_PROBLEM_TYPES.AUTHORING_STATE_BASE_MISSING:
      return "Run `dreamboard pull --force` in a clean workspace to recover the remote authored state. If the remote has no authored state, run `dreamboard sync --force` from the local source-of-truth workspace.";
    case CLI_PROBLEM_TYPES.INTERNAL_ERROR:
      return "Retry the command. If it still fails, include the request id when asking for help.";
    default:
      return undefined;
  }
}

function getProblemDetails(problem: ApiProblem): string[] {
  return [
    `Problem: ${problem.type}`,
    problem.instance ? `Endpoint: ${problem.instance}` : undefined,
    problem.requestId ? `Request ID: ${problem.requestId}` : undefined,
    problem.timestamp ? `Timestamp: ${problem.timestamp}` : undefined,
  ].filter((detail): detail is string => Boolean(detail));
}

export function presentCliError(error: unknown): CliErrorPresentation {
  if (isDreamboardApiError(error)) {
    return {
      message: formatProblem(error.problem),
      resolution: getProblemResolution(error.problem),
      details: getProblemDetails(error.problem),
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      details: [],
    };
  }

  if (typeof error === "object" && error !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(error);
    } catch {
      serialized = String(error);
    }
    return {
      message: serialized,
      details: [],
    };
  }

  return {
    message: String(error),
    details: [],
  };
}

export function formatCliError(error: unknown): string {
  const presentation = presentCliError(error);
  return [
    presentation.message,
    presentation.resolution
      ? `Resolution: ${presentation.resolution}`
      : undefined,
    ...presentation.details,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
