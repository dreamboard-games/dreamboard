import type { CommandId, CommandResult } from "../results/command-result.js";

export const PROGRESS_EVENT_SCHEMA_VERSION = 1;

export type ProgressEventKind = "progress" | "result";

export type ProgressEvent<TPayload = unknown> = {
  readonly schemaVersion: typeof PROGRESS_EVENT_SCHEMA_VERSION;
  readonly runId: string;
  readonly seq: number;
  readonly command: CommandId;
  readonly kind: ProgressEventKind;
  readonly event: string;
  readonly payload?: TPayload;
};

export type TerminalResultEvent<T> = ProgressEvent<CommandResult<T>> & {
  readonly kind: "result";
  readonly event: "terminal";
  readonly payload: CommandResult<T>;
};

export type ProgressSequencer = {
  next<TPayload>(
    event: Omit<ProgressEvent<TPayload>, "schemaVersion" | "runId" | "seq">,
  ): ProgressEvent<TPayload>;
  terminal<T>(result: CommandResult<T>): TerminalResultEvent<T>;
};

export function createProgressSequencer(input: {
  runId: string;
  command: CommandId;
}): ProgressSequencer {
  let seq = 0;
  const sequencer: ProgressSequencer = {
    next<TPayload>(
      event: Omit<
        ProgressEvent<TPayload>,
        "schemaVersion" | "runId" | "seq"
      >,
    ) {
      seq += 1;
      return {
        schemaVersion: PROGRESS_EVENT_SCHEMA_VERSION,
        runId: input.runId,
        seq,
        ...event,
      };
    },
    terminal<T>(result: CommandResult<T>) {
      seq += 1;
      return {
        schemaVersion: PROGRESS_EVENT_SCHEMA_VERSION,
        runId: input.runId,
        seq,
        command: input.command,
        kind: "result",
        event: "terminal",
        payload: result,
      };
    },
  };
  return sequencer;
}
