export const COMMAND_RESULT_SCHEMA_VERSION = 1;

export type CommandId =
  | "auth.login"
  | "auth.logout"
  | "auth.status"
  | "auth.git_credential"
  | "project.create"
  | "project.clone"
  | "project.status"
  | "verify"
  | "test"
  | "dev"
  | "build"
  | "preview"
  | "release.publish"
  | "release.current"
  | "doctor";

export enum ExitCode {
  Ok = 0,
  Unexpected = 1,
  Unauthenticated = 2,
  Forbidden = 3,
  Conflict = 4,
  Validation = 5,
  Transient = 6,
  CommitNotPushed = 7,
  ConfirmationRequired = 8,
}

export type ProblemDetails = {
  readonly type?: string;
  readonly title: string;
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: Record<string, readonly string[]>;
};

export type AuthLoginAction = {
  readonly id: "auth.login";
  readonly environment: string;
  readonly unattended: false;
};

export type GitPushRequiredAction = {
  readonly id: "git.push_required";
  readonly commitOid: string;
  readonly remote: "origin";
  readonly unattended: false;
};

export type ValidationFixAction = {
  readonly id: "validation.fix";
  readonly diagnosticIds: readonly string[];
  readonly unattended: false;
};

export type ReleaseConfirmRequiredAction = {
  readonly id: "release.confirm_required";
  readonly commitOid: string;
  readonly unattended: false;
};

export type RetryAction = {
  readonly id: "retry";
  readonly afterSeconds?: number;
  readonly unattended: true;
};

export type NextAction =
  | AuthLoginAction
  | GitPushRequiredAction
  | ValidationFixAction
  | ReleaseConfirmRequiredAction
  | RetryAction;

export type CommandSuccess<T> = {
  readonly schemaVersion: typeof COMMAND_RESULT_SCHEMA_VERSION;
  readonly ok: true;
  readonly command: CommandId;
  readonly result: T;
  readonly nextActions: readonly NextAction[];
};

export type CommandFailure = {
  readonly schemaVersion: typeof COMMAND_RESULT_SCHEMA_VERSION;
  readonly ok: false;
  readonly command: CommandId;
  readonly problem: ProblemDetails;
  readonly nextActions: readonly NextAction[];
  readonly exitCode: ExitCode;
};

export type CommandResult<T> = CommandSuccess<T> | CommandFailure;

export function commandSuccess<T>(
  command: CommandId,
  result: T,
  nextActions: readonly NextAction[] = [],
): CommandSuccess<T> {
  return {
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    ok: true,
    command,
    result,
    nextActions,
  };
}

export function commandFailure(
  command: CommandId,
  problem: ProblemDetails,
  exitCode: ExitCode,
  nextActions: readonly NextAction[] = [],
): CommandFailure {
  return {
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    ok: false,
    command,
    problem,
    nextActions,
    exitCode,
  };
}

export function isUnattendedAction(action: NextAction): action is RetryAction {
  return action.unattended === true;
}
