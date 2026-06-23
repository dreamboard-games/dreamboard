import type {
  ExitCode,
  NextAction,
  ProblemDetails as CliProblemDetails,
} from "@dreamboard-games/cli-core";
import type {
  ProblemDetails as ApiProblemDetails,
  ProblemViolation,
} from "@dreamboard-games/api-client";
import { zProblemDetails } from "@dreamboard-games/api-client/zod.gen";
import { CLI_PROBLEM_TYPES } from "./problem-types.js";
import type { CliProblemType } from "./problem-types.js";

type ApiClientError =
  | ApiProblemDetails
  | Error
  | string
  | Record<string, unknown>
  | null
  | undefined;

type ProblemContextValue = string | number | boolean;
export type CliProblemContext = Readonly<Record<string, ProblemContextValue>>;

type ApiProblem = Omit<ApiProblemDetails, "type" | "context"> & {
  type: CliProblemType | (string & {});
  code?: string;
  context?: CliProblemContext;
};

type CliErrorPresentation = {
  message: string;
  resolution?: string;
  details: string[];
};

export type ProjectCreateStep =
  | "configure_client"
  | "prepare_local_packages"
  | "resolve_identity"
  | "ensure_project"
  | "ensure_repository"
  | "wait_for_repository"
  | "materialize_workspace"
  | "configure_git";

export type CliOperationContext = CliProblemContext & {
  operationId: string;
  command: "project.create";
  step: ProjectCreateStep;
  environment: "local" | "staging" | "prod";
  apiBaseUrl: string;
  slug: string;
  projectId: string;
  targetDir: string;
  remoteProjectState: "not_started" | "attempted" | "confirmed";
  repositoryState: "not_started" | "attempted" | "confirmed";
  workspaceState: "not_started" | "attempted" | "confirmed";
  gitState: "not_started" | "attempted" | "confirmed";
};

export type ClassifiedCliFailure = {
  problem: CliProblemDetails;
  exitCode: ExitCode;
  nextActions: readonly NextAction[];
  humanDetails: readonly string[];
};

export const STALE_CONTRACT_ARTIFACT_CODE = "STALE_CONTRACT_ARTIFACT";
export const STALE_CONTRACT_ARTIFACT_EXIT_CODE = 42;
export const PROJECT_CREATE_STEP_FAILED_CODE = "PROJECT_CREATE_STEP_FAILED";

const CLI_EXIT_CODE = {
  Unexpected: 1,
  Unauthenticated: 2,
  Forbidden: 3,
  Conflict: 4,
  Validation: 5,
  Transient: 6,
} as const satisfies Record<string, ExitCode>;

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

export function isProblemDetails(value: unknown): value is ApiProblemDetails {
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
  if (response === undefined) {
    return {
      type: CLI_PROBLEM_TYPES.TRANSPORT_ERROR,
      title: "Could not reach the Dreamboard API",
      status: 0,
      detail: getTransportDetail(error, fallback),
      code: "API_TRANSPORT_ERROR",
    };
  }

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
      title: response.statusText || "API error",
      status: response?.status ?? 0,
      detail: error.message || fallback,
      code: "API_TRANSPORT_ERROR",
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
            ? coerceProblemContext(obj.context)
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
    code: "API_UNKNOWN_ERROR",
    requestId: getRequestId(response),
  };
}

function getTransportDetail(error: ApiClientError, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.message === "string") return obj.message;
  }
  return fallback;
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

  withOperationContext(context: CliOperationContext): DreamboardApiError {
    return new DreamboardApiError(
      {
        ...this.problem,
        context: {
          ...this.problem.context,
          ...sanitizeProblemContext(context),
        },
      },
      this.cause ?? this,
    );
  }
}

export class CliOperationError extends Error {
  readonly code: string;
  readonly context: CliOperationContext;

  constructor(options: {
    code: string;
    message: string;
    context: CliOperationContext;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "CliOperationError";
    this.code = options.code;
    this.context = options.context;
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

export function isCliOperationError(
  error: unknown,
): error is CliOperationError {
  return error instanceof CliOperationError;
}

export function contextualizeCliError(
  cause: unknown,
  context: CliOperationContext,
): Error {
  if (cause instanceof DreamboardApiError) {
    return cause.withOperationContext(context);
  }
  return new CliOperationError({
    code: PROJECT_CREATE_STEP_FAILED_CODE,
    message: cause instanceof Error ? cause.message : String(cause),
    context,
    cause,
  });
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

export function getProblemContext(
  error: unknown,
): CliProblemContext | undefined {
  if (isDreamboardApiError(error)) return error.problem.context;
  if (isCliOperationError(error)) return sanitizeProblemContext(error.context);
  return undefined;
}

export function getProblemContextValue(
  error: unknown,
  key: string,
): string | undefined {
  const value = getProblemContext(error)?.[key];
  return typeof value === "string" ? value : undefined;
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
      "Verify the project binding with `dreamboard project status --commit <rev>` after pushing the exact commit.",
      "If you meant to use an existing remote project, check that your selected account and environment point at the backend that has that project.",
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
      return "Push the exact Git commit, then run `dreamboard project status --commit <rev> --wait` before retrying.";
    case CLI_PROBLEM_TYPES.SOURCE_REVISION_DRIFT:
    case CLI_PROBLEM_TYPES.AUTHORING_STATE_DRIFT:
    case CLI_PROBLEM_TYPES.STATE_CONFLICT:
      return "Resolve the Git/source conflict in your worktree, push the intended exact commit, and retry the command against that commit.";
    case CLI_PROBLEM_TYPES.SOURCE_REVISION_BASE_MISSING:
    case CLI_PROBLEM_TYPES.AUTHORING_STATE_BASE_MISSING:
      return "Clone the project repository into a clean workspace or push the intended exact commit before retrying.";
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

function coerceProblemContext(value: unknown): CliProblemContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, ProblemContextValue] => {
      const entryValue = entry[1];
      return (
        typeof entryValue === "string" ||
        typeof entryValue === "number" ||
        typeof entryValue === "boolean"
      );
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeUrlForOutput(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return value;
  }
}

function sanitizeProblemContext(context: CliProblemContext): CliProblemContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "string" &&
      (key === "apiBaseUrl" || key.toLowerCase().endsWith("url"))
        ? sanitizeUrlForOutput(value)
        : value,
    ]),
  );
}

function cliProblemFromApiProblem(problem: ApiProblem): CliProblemDetails {
  return {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    code: problem.code ?? problem.type,
    requestId: problem.requestId,
    context: problem.context
      ? sanitizeProblemContext(problem.context)
      : undefined,
  };
}

function getExitCodeFromError(error: unknown): ExitCode {
  if (isStaleContractArtifactError(error)) return CLI_EXIT_CODE.Validation;
  if (isDreamboardApiError(error)) {
    if (error.problem.type === CLI_PROBLEM_TYPES.TRANSPORT_ERROR) {
      return CLI_EXIT_CODE.Transient;
    }
    if (error.status === 401) return CLI_EXIT_CODE.Unauthenticated;
    if (error.status === 403) return CLI_EXIT_CODE.Forbidden;
    if (error.status === 409) return CLI_EXIT_CODE.Conflict;
    if (error.status === 422 || error.status === 400) {
      return CLI_EXIT_CODE.Validation;
    }
    if (error.retryable || error.status === 429 || error.status >= 500) {
      return CLI_EXIT_CODE.Transient;
    }
  }
  return CLI_EXIT_CODE.Unexpected;
}

function getNextActionsFromError(error: unknown): readonly NextAction[] {
  if (isDreamboardApiError(error) && error.status === 401) {
    const environment = getProblemContextValue(error, "environment") ?? "staging";
    return [
      {
        id: "auth.login",
        environment,
        unattended: false,
      },
    ];
  }
  if (
    isDreamboardApiError(error) &&
    (error.problem.type === CLI_PROBLEM_TYPES.TRANSPORT_ERROR ||
      error.retryable ||
      error.status === 429 ||
      error.status >= 500)
  ) {
    return [{ id: "retry", unattended: true }];
  }
  if (isCliOperationError(error)) {
    return [{ id: "retry", unattended: true }];
  }
  return [];
}

function operationDetails(context: CliProblemContext | undefined): string[] {
  if (!context) return [];
  return [
    typeof context.step === "string" ? `Step: ${context.step}` : undefined,
    typeof context.operationId === "string"
      ? `Operation ID: ${context.operationId}`
      : undefined,
    typeof context.projectId === "string"
      ? `Project ID: ${context.projectId}`
      : undefined,
  ].filter((detail): detail is string => Boolean(detail));
}

export function classifyCliFailure(error: unknown): ClassifiedCliFailure {
  if (isDreamboardApiError(error)) {
    const presentation = presentCliError(error);
    return {
      problem: cliProblemFromApiProblem(error.problem),
      exitCode: getExitCodeFromError(error),
      nextActions: getNextActionsFromError(error),
      humanDetails: [
        ...presentation.details,
        ...operationDetails(error.problem.context),
      ],
    };
  }

  if (isCliOperationError(error)) {
    const context = sanitizeProblemContext(error.context);
    return {
      problem: {
        title: "Project create step failed",
        detail: error.message,
        code: error.code,
        context,
      },
      exitCode: CLI_EXIT_CODE.Unexpected,
      nextActions: getNextActionsFromError(error),
      humanDetails: operationDetails(context),
    };
  }

  const presentation = presentCliError(error);
  return {
    problem: {
      title: presentation.message || "Command failed",
      detail: presentation.resolution,
      code: error instanceof Error ? error.name : undefined,
    },
    exitCode: getExitCodeFromError(error),
    nextActions: getNextActionsFromError(error),
    humanDetails: presentation.details,
  };
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
  const failure = classifyCliFailure(error);
  const message = failure.problem.detail
    ? `${failure.problem.detail}${failure.problem.status ? ` (HTTP ${failure.problem.status})` : ""}`
    : failure.problem.title;
  const resolution =
    isDreamboardApiError(error) && getProblemResolution(error.problem)
      ? `Resolution: ${getProblemResolution(error.problem)}`
      : undefined;
  const stack =
    process.env.DREAMBOARD_CLI_DEBUG === "1" && error instanceof Error
      ? error.stack
      : undefined;
  return [message, resolution, ...failure.humanDetails, stack]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function getCliErrorExitCode(error: unknown): number {
  return classifyCliFailure(error).exitCode;
}

export function problemFromError(error: unknown): CliProblemDetails {
  return classifyCliFailure(error).problem;
}

export function exitCodeFromError(error: unknown): ExitCode {
  return classifyCliFailure(error).exitCode;
}

export function nextActionsFromError(error: unknown): readonly NextAction[] {
  return classifyCliFailure(error).nextActions;
}
