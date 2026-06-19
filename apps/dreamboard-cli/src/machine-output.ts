import crypto from "node:crypto";
import {
  ExitCode,
  commandFailure,
  commandSuccess,
  createProgressSequencer,
  type CommandId,
  type CommandResult,
  type ProblemDetails,
} from "@dreamboard-games/cli-core";
import {
  isDreamboardApiError,
  isStaleContractArtifactError,
  presentCliError,
} from "./utils/errors.js";

export type MachineMode = "json" | "json-events";

export type MachineOutputContext = {
  readonly mode: MachineMode;
  readonly runId: string;
};

export type CapturedCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export function consumeMachineOutputMode(
  argv: string[],
): MachineOutputContext | null {
  let mode: MachineMode | null = null;
  for (let index = argv.length - 1; index >= 2; index -= 1) {
    const arg = argv[index];
    if (arg !== "--json" && arg !== "--json-events") continue;
    const nextMode = arg === "--json" ? "json" : "json-events";
    if (mode && mode !== nextMode) {
      throw new Error("Use only one machine output mode: --json or --json-events.");
    }
    mode = nextMode;
    argv.splice(index, 1);
  }

  return mode
    ? {
        mode,
        runId: crypto.randomUUID(),
      }
    : null;
}

export function commandPathToId(path: readonly string[]): CommandId {
  const [first, second] = path;
  if (first === "auth") {
    if (second === "git-credential") return "auth.git_credential";
    if (second === "status") return "auth.status";
    if (second === "clear") return "auth.logout";
    return "auth.login";
  }
  switch (first) {
    case "login":
      return "auth.login";
    case "logout":
      return "auth.logout";
    case "new":
      return "project.create";
    case "clone":
      return "project.clone";
    case "status":
    case "pull":
      return "project.status";
    case "sync":
      return "verify";
    case "compile":
      return "build";
    case "test":
      return "test";
    case "dev":
    case "join":
      return "dev";
    case "config":
    case "query":
      return "doctor";
    default:
      return "doctor";
  }
}

export async function runWithMachineOutput<T>(
  context: MachineOutputContext,
  command: CommandId,
  run: () => Promise<T>,
): Promise<void> {
  const sequencer = createProgressSequencer({
    runId: context.runId,
    command,
  });
  if (context.mode === "json-events") {
    writeJsonLine(
      sequencer.next({
        command,
        kind: "progress",
        event: "started",
      }),
    );
  }

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    const captured = await captureProcessWrites(async () => {
      await run();
    });
    const exitCode =
      typeof process.exitCode === "number" ? process.exitCode : ExitCode.Ok;
    const result =
      exitCode === 0
        ? commandSuccess(command, captured)
        : commandFailure(
            command,
            {
              title: "Command failed",
              detail: `Command completed with exit code ${exitCode}.`,
              code: "COMMAND_EXIT_CODE",
            },
            normalizeExitCode(exitCode),
          );

    emitMachineResult(context, sequencer.terminal(result), result);
    process.exitCode = exitCode;
  } catch (error) {
    const failure = commandFailure(
      command,
      problemFromError(error),
      exitCodeFromError(error),
      nextActionsFromError(error),
    );
    emitMachineResult(context, sequencer.terminal(failure), failure);
    process.exit(exitCodeFromError(error));
  } finally {
    if (process.exitCode === 0 && previousExitCode) {
      process.exitCode = previousExitCode;
    }
  }
}

export function emitMachineFailureAndExit(
  context: MachineOutputContext,
  command: CommandId,
  error: unknown,
): never {
  const sequencer = createProgressSequencer({
    runId: context.runId,
    command,
  });
  const failure = commandFailure(
    command,
    problemFromError(error),
    exitCodeFromError(error),
    nextActionsFromError(error),
  );
  emitMachineResult(context, sequencer.terminal(failure), failure);
  process.exit(failure.exitCode);
}

async function captureProcessWrites(
  run: () => Promise<void>,
): Promise<CapturedCommandResult> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdout += stringifyChunk(chunk);
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderr += stringifyChunk(chunk);
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    await run();
    return {
      exitCode:
        typeof process.exitCode === "number"
          ? process.exitCode
          : ExitCode.Ok,
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = stdoutWrite as typeof process.stdout.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;
  }
}

function emitMachineResult<T>(
  context: MachineOutputContext,
  terminalEvent: ReturnType<ReturnType<typeof createProgressSequencer>["terminal"]>,
  result: CommandResult<T>,
): void {
  if (context.mode === "json-events") {
    writeJsonLine(terminalEvent);
    return;
  }
  writeJsonLine(result);
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function stringifyChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

function problemFromError(error: unknown): ProblemDetails {
  if (isDreamboardApiError(error)) {
    return {
      type: error.problem.type,
      title: error.problem.title,
      status: error.problem.status,
      detail: error.problem.detail,
      code: error.problem.type,
    };
  }

  const presentation = presentCliError(error);
  return {
    title: presentation.message || "Command failed",
    detail: presentation.resolution,
    code: error instanceof Error ? error.name : undefined,
  };
}

function exitCodeFromError(error: unknown): ExitCode {
  if (isStaleContractArtifactError(error)) return ExitCode.Validation;
  if (isDreamboardApiError(error)) {
    if (error.status === 401) return ExitCode.Unauthenticated;
    if (error.status === 403) return ExitCode.Forbidden;
    if (error.status === 409) return ExitCode.Conflict;
    if (error.status === 422 || error.status === 400) {
      return ExitCode.Validation;
    }
    if (error.retryable || error.status === 429 || error.status >= 500) {
      return ExitCode.Transient;
    }
  }
  return ExitCode.Unexpected;
}

function normalizeExitCode(exitCode: number): ExitCode {
  return Object.values(ExitCode).includes(exitCode)
    ? (exitCode as ExitCode)
    : ExitCode.Unexpected;
}

function nextActionsFromError(error: unknown) {
  if (isDreamboardApiError(error) && error.status === 401) {
    return [
      {
        id: "auth.login" as const,
        environment: "staging",
        unattended: false as const,
      },
    ];
  }
  return [];
}
