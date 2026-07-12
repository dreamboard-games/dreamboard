import crypto from "node:crypto";
import {
  COMMAND_RESULT_SCHEMA_VERSION,
  ExitCode,
  commandFailure,
  commandSuccess,
  createProgressSequencer,
  type CommandId,
  type NextAction,
  type ProblemDetails,
  type CommandResult,
} from "@dreamboard-games/cli-core";
import { classifyCliFailure } from "./utils/errors.js";

export type MachineMode = "json" | "json-events";

export type MachineOutputContext = {
  readonly mode: MachineMode;
  readonly runId: string;
  /** Semantic commands return their own result DTO instead of captured prose. */
  readonly semanticJson: boolean;
};

export type CapturedCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type MachineFailureClassification = {
  readonly problem: ProblemDetails;
  readonly exitCode: ExitCode;
  readonly nextActions?: readonly NextAction[];
};

export type MachineOutputOptions = {
  readonly classifySemanticFailure?: (
    error: unknown,
    command: CommandId,
  ) => MachineFailureClassification;
};

export type SemanticOutputViolationCategory =
  | "invalid-command-result"
  | "command-result-mismatch"
  | "side-channel-output";

export class SemanticOutputViolationError extends Error {
  readonly category: SemanticOutputViolationCategory;

  constructor(category: SemanticOutputViolationCategory) {
    super(`Semantic command output violated the '${category}' boundary.`);
    this.name = "SemanticOutputViolationError";
    this.category = category;
  }
}

export function consumeMachineOutputMode(
  argv: string[],
): MachineOutputContext | null {
  let sawJson = false;
  let sawJsonEvents = false;
  for (let index = argv.length - 1; index >= 2; index -= 1) {
    const arg = argv[index];
    if (arg !== "--json" && arg !== "--json-events") continue;
    sawJson ||= arg === "--json";
    sawJsonEvents ||= arg === "--json-events";
    argv.splice(index, 1);
  }

  const semanticJson = argv[2] === "test";
  if (sawJson && sawJsonEvents && !semanticJson) {
    throw new Error(
      "Use only one machine output mode: --json or --json-events.",
    );
  }

  const mode: MachineMode | null = sawJsonEvents
    ? "json-events"
    : sawJson || semanticJson
      ? "json"
      : null;

  return mode
    ? {
        mode,
        runId: crypto.randomUUID(),
        semanticJson,
      }
    : null;
}

export function commandPathToId(path: readonly string[]): CommandId {
  const [first, second] = path;
  if (first === "auth") {
    if (second === "git-credential") return "auth.git_credential";
    if (second === "status") return "auth.status";
    if (second === "logout") return "auth.logout";
    return "auth.login";
  }
  if (first === "project") {
    if (second === "create") return "project.create";
    if (second === "clone") return "project.clone";
    return "project.status";
  }
  if (first === "release") {
    if (second === "publish") return "release.publish";
    return "release.current";
  }
  switch (first) {
    case "verify":
      return "verify";
    case "test": {
      const operation = findTestOperation(path.slice(1));
      if (operation === "inspect") return "test.inspect";
      if (operation === "explore") return "test.explore";
      return "test";
    }
    case "dev":
      return "dev";
    case "build":
      return "build";
    case "preview":
      return "preview";
    case "doctor":
      return "doctor";
    default:
      return "doctor";
  }
}

const TEST_VALUE_OPTIONS = new Set([
  "--at",
  "--cursor",
  "--env",
  "--limit",
  "--max-evaluations",
  "--perspective",
  "--scenario",
  "--seed",
  "--seed-range",
  "--token",
]);

function findTestOperation(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && TEST_VALUE_OPTIONS.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

export async function runWithMachineOutput<T>(
  context: MachineOutputContext,
  command: CommandId,
  run: () => Promise<T>,
  options: MachineOutputOptions = {},
): Promise<void> {
  if (context.semanticJson) {
    await runWithSemanticOutput(context, command, run, options);
    return;
  }

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
    const capturedResult: CapturedCommandResult = {
      exitCode: captured.exitCode,
      stdout: captured.stdout,
      stderr: captured.stderr,
    };
    const exitCode =
      typeof process.exitCode === "number" ? process.exitCode : ExitCode.Ok;
    const result =
      exitCode === 0
        ? commandSuccess(command, capturedResult)
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
    const classified = classifyCliFailure(error);
    const failure = commandFailure(
      command,
      classified.problem,
      classified.exitCode,
      classified.nextActions,
    );
    emitMachineResult(context, sequencer.terminal(failure), failure);
    process.exit(classified.exitCode);
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
  options: MachineOutputOptions = {},
): never {
  const sequencer = createProgressSequencer({
    runId: context.runId,
    command,
  });
  const classified = context.semanticJson
    ? classifySemanticFailure(error, command, options)
    : classifyCliFailure(error);
  const failure = commandFailure(
    command,
    classified.problem,
    classified.exitCode,
    classified.nextActions,
  );
  emitMachineResult(context, sequencer.terminal(failure), failure);
  process.exit(failure.exitCode);
}

async function runWithSemanticOutput<T>(
  context: MachineOutputContext,
  command: CommandId,
  run: () => Promise<T>,
  options: MachineOutputOptions,
): Promise<void> {
  if (context.mode === "json-events") {
    const failure = commandFailure(
      command,
      {
        title: "JSON events are not supported by test commands",
        code: "TEST_JSON_EVENTS_UNSUPPORTED",
        context: { requestedMode: "json-events" },
      },
      ExitCode.Validation,
    );
    writeJsonLine(failure);
    process.exitCode = failure.exitCode;
    return;
  }

  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    const captured = await captureProcessWrites(run);
    if (captured.stdout !== "" || captured.stderr !== "") {
      throw new SemanticOutputViolationError("side-channel-output");
    }
    if (!isCommandResult(captured.value)) {
      throw new SemanticOutputViolationError("invalid-command-result");
    }
    if (captured.value.command !== command) {
      throw new SemanticOutputViolationError("command-result-mismatch");
    }

    writeJsonLine(captured.value);
    process.exitCode = captured.value.ok
      ? ExitCode.Ok
      : captured.value.exitCode;
  } catch (error) {
    const classified = classifySemanticFailure(error, command, options);
    const failure = commandFailure(
      command,
      classified.problem,
      classified.exitCode,
      classified.nextActions,
    );
    writeJsonLine(failure);
    process.exitCode = failure.exitCode;
  } finally {
    if (process.exitCode === 0 && previousExitCode) {
      process.exitCode = previousExitCode;
    }
  }
}

async function captureProcessWrites<T>(
  run: () => Promise<T>,
): Promise<CapturedCommandResult & { readonly value: T }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    stdout += stringifyChunk(chunk);
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function",
    );
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    stderr += stringifyChunk(chunk);
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function",
    );
    callback?.();
    return true;
  }) as typeof process.stderr.write;

  try {
    const value = await run();
    return {
      exitCode:
        typeof process.exitCode === "number" ? process.exitCode : ExitCode.Ok,
      stdout,
      stderr,
      value,
    };
  } finally {
    process.stdout.write = stdoutWrite as typeof process.stdout.write;
    process.stderr.write = stderrWrite as typeof process.stderr.write;
  }
}

function classifySemanticFailure(
  error: unknown,
  command: CommandId,
  options: MachineOutputOptions,
): MachineFailureClassification {
  return (
    options.classifySemanticFailure?.(error, command) ?? {
      problem: {
        title: "The semantic command failed unexpectedly",
        code: "TEST_UNEXPECTED",
        context: { category: "execution" },
      },
      exitCode: ExitCode.Unexpected,
    }
  );
}

function isCommandResult(value: unknown): value is CommandResult<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === COMMAND_RESULT_SCHEMA_VERSION &&
    typeof candidate.ok === "boolean" &&
    typeof candidate.command === "string" &&
    Array.isArray(candidate.nextActions) &&
    (candidate.ok === true || typeof candidate.exitCode === "number")
  );
}

function emitMachineResult<T>(
  context: MachineOutputContext,
  terminalEvent: ReturnType<
    ReturnType<typeof createProgressSequencer>["terminal"]
  >,
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

function normalizeExitCode(exitCode: number): ExitCode {
  return Object.values(ExitCode).includes(exitCode)
    ? (exitCode as ExitCode)
    : ExitCode.Unexpected;
}
