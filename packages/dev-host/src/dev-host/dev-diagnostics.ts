import type { LoggerLike } from "@dreamboard-games/ui-host-runtime/runtime";

export type DevLogEnvelope = {
  source: "host" | "plugin" | "sse";
  level: "log" | "warn" | "error" | "info";
  message: string;
};

export type DevDiagnosticsLevel = "errors" | "verbose";

export function resolveDevDiagnosticsLevel(
  debug: boolean,
): DevDiagnosticsLevel {
  return debug ? "verbose" : "errors";
}

export function createDevDiagnosticsLogger(
  level: DevDiagnosticsLevel,
): LoggerLike {
  if (level === "verbose") {
    return {
      log: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    };
  }

  return {
    log: () => {},
    warn: () => {},
    error: (...args) => console.error(...args),
  };
}

export function shouldRelayDevLog(
  diagnosticsLevel: DevDiagnosticsLevel,
  payload: DevLogEnvelope,
): boolean {
  return (
    diagnosticsLevel === "verbose" ||
    payload.level === "warn" ||
    payload.level === "error"
  );
}

export function formatConsoleArgs(args: unknown[]): string {
  return args.map((value) => stringifyForRelay(value)).join(" ");
}

export function stringifyForRelay(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
