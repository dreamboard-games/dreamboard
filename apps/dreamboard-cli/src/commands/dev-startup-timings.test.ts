import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createDevStartupTimingCollector,
  devDiagnosticArgs,
  hasDevStartupTimingArg,
  sanitizeDevStartupMessage,
  shouldEnableDevStartupDiagnostics,
  writeDevStartupTimingReport,
} from "./dev-startup-timings.js";

describe("dev startup timings", () => {
  test("records successful and failed phases", async () => {
    const timings = createDevStartupTimingCollector();

    await timings.timed("resolveProjectContext", async () => "ok");
    await expect(
      timings.timed("localTypecheck", async () => {
        throw new Error("typecheck failed");
      }),
    ).rejects.toThrow("typecheck failed");

    const report = timings.report("failed");
    expect(report.format).toBe("dreamboard.dev-startup-timings/v1");
    expect(report.status).toBe("failed");
    expect(report.timings).toEqual([
      {
        name: "resolveProjectContext",
        durationMs: expect.any(Number),
        outcome: "ran",
      },
      {
        name: "localTypecheck",
        durationMs: expect.any(Number),
        outcome: "failed",
      },
    ]);
  });

  test("writes only redacted phase timing fields", async () => {
    const tempDir = await makeTempDir();
    const filePath = path.join(tempDir, "startup.json");

    const timings = createDevStartupTimingCollector();
    timings.record("uploadSource", Number.NaN, "skipped");
    await writeDevStartupTimingReport(filePath, timings.report("ready"));

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(parsed).toEqual({
      format: "dreamboard.dev-startup-timings/v1",
      status: "ready",
      totalDurationMs: expect.any(Number),
      timings: [
        {
          name: "uploadSource",
          durationMs: 0,
          outcome: "skipped",
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("token");
    expect(JSON.stringify(parsed)).not.toContain("https://");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("redacts token-like compile progress and signed URL query strings", () => {
    expect(
      sanitizeDevStartupMessage(
        "queued access_token=secret https://storage.example/file?X-Amz-Signature=abc Bearer abc.def.ghi",
      ),
    ).toBe(
      "queued [redacted] https://storage.example/file?[redacted] Bearer [redacted]",
    );
  });

  test("gates the hidden timings argument to development and alpha builds", () => {
    expect(
      shouldEnableDevStartupDiagnostics({
        buildChannel: "development",
        packageVersion: "0.1.30",
      }),
    ).toBe(true);
    expect(
      shouldEnableDevStartupDiagnostics({
        buildChannel: "published",
        packageVersion: "0.1.99-alpha.0",
      }),
    ).toBe(true);
    expect(
      shouldEnableDevStartupDiagnostics({
        buildChannel: "published",
        packageVersion: "0.1.30",
      }),
    ).toBe(false);

    expect(devDiagnosticArgs(true)).toEqual({
      "timings-json": {
        type: "string",
        hidden: true,
      },
    });
    expect(devDiagnosticArgs(false)).toEqual({});
    expect(hasDevStartupTimingArg(["--timings-json", "out.json"])).toBe(true);
    expect(hasDevStartupTimingArg(["--timings-json=out.json"])).toBe(true);
    expect(hasDevStartupTimingArg(["--debug"])).toBe(false);
  });
});

async function makeTempDir(): Promise<string> {
  const tempDir = path.join(
    os.tmpdir(),
    `dreamboard-dev-timings-${Date.now()}`,
  );
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}
