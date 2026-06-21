import path from "node:path";
import { performance } from "node:perf_hooks";
import { IS_ALPHA_RELEASE, IS_PUBLISHED_BUILD } from "../build-target.js";
import { writeJsonFile } from "../utils/fs.js";

export type DevStartupPhase =
  | "resolveProjectContext"
  | "resolveRemoteProject"
  | "startProgressHost"
  | "refreshScaffold"
  | "workspaceCodegen"
  | "dependencyReconcile"
  | "reducerContract"
  | "localTypecheck"
  | "reducerSmoke"
  | "computeFingerprint"
  | "lookupCompile"
  | "uploadSource"
  | "waitForCompile"
  | "createSession"
  | "activateDevHost";

export type DevStartupTimingOutcome = "ran" | "reused" | "skipped" | "failed";

export type DevStartupTiming = {
  name: DevStartupPhase;
  durationMs: number;
  outcome: DevStartupTimingOutcome;
};

export type DevStartupTimingReport = {
  format: "dreamboard.dev-startup-timings/v1";
  status: "ready" | "failed";
  totalDurationMs: number;
  timings: DevStartupTiming[];
};

export type DevStartupTimingCollector = ReturnType<
  typeof createDevStartupTimingCollector
>;

type TimingTarget = {
  buildChannel: "development" | "published";
  packageVersion: string;
};

export function shouldEnableDevStartupDiagnostics(
  target: TimingTarget,
): boolean {
  return (
    target.buildChannel === "development" ||
    isAlphaVersion(target.packageVersion)
  );
}

export const DEV_STARTUP_DIAGNOSTICS_ENABLED =
  !IS_PUBLISHED_BUILD || IS_ALPHA_RELEASE;

export function hasDevStartupTimingArg(rawArgs: readonly string[]): boolean {
  return rawArgs.some(
    (arg) => arg === "--timings-json" || arg.startsWith("--timings-json="),
  );
}

export function devDiagnosticArgs(enabled = DEV_STARTUP_DIAGNOSTICS_ENABLED) {
  const args: Record<string, { type: "string"; hidden: true }> = {};
  if (enabled) {
    args["timings-json"] = {
      type: "string" as const,
      hidden: true,
    };
  }
  return args;
}

export function createDevStartupTimingCollector() {
  const startedAt = performance.now();
  const timings: DevStartupTiming[] = [];

  return {
    async timed<T>(
      name: DevStartupPhase,
      task: () => Promise<T>,
      outcome: DevStartupTimingOutcome = "ran",
    ): Promise<T> {
      const phaseStartedAt = performance.now();
      try {
        const result = await task();
        timings.push({
          name,
          durationMs: elapsedMsSince(phaseStartedAt),
          outcome,
        });
        return result;
      } catch (error) {
        timings.push({
          name,
          durationMs: elapsedMsSince(phaseStartedAt),
          outcome: "failed",
        });
        throw error;
      }
    },
    record(
      name: DevStartupPhase,
      durationMs: number,
      outcome: DevStartupTimingOutcome,
    ): void {
      timings.push({
        name,
        durationMs: sanitizeDuration(durationMs),
        outcome,
      });
    },
    report(status: DevStartupTimingReport["status"]): DevStartupTimingReport {
      return {
        format: "dreamboard.dev-startup-timings/v1",
        status,
        totalDurationMs: elapsedMsSince(startedAt),
        timings: timings.map((timing) => ({ ...timing })),
      };
    },
  };
}

export async function writeDevStartupTimingReport(
  filePath: string | undefined,
  report: DevStartupTimingReport,
): Promise<void> {
  if (!filePath) return;
  await writeJsonFile(path.resolve(filePath), sanitizeTimingReport(report));
}

export function sanitizeTimingReport(
  report: DevStartupTimingReport,
): DevStartupTimingReport {
  return {
    format: report.format,
    status: report.status,
    totalDurationMs: sanitizeDuration(report.totalDurationMs),
    timings: report.timings.map((timing) => ({
      name: timing.name,
      durationMs: sanitizeDuration(timing.durationMs),
      outcome: timing.outcome,
    })),
  };
}

export function sanitizeDevStartupMessage(message: string | null | undefined) {
  if (!message) return "";
  return message
    .replace(
      /\b(?:access_token|refresh_token|id_token|token|jwt|signature|x-amz-signature)=([^&\s]+)/gi,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-jwt]",
    )
    .replace(/https?:\/\/[^\s)]+[?][^\s)]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}?[redacted]`;
      } catch {
        return "[redacted-url]";
      }
    });
}

function elapsedMsSince(startedAt: number): number {
  return sanitizeDuration(performance.now() - startedAt);
}

function sanitizeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isAlphaVersion(version: string): boolean {
  return /(?:^|-|\.)alpha(?:$|-|\.)/.test(version);
}
