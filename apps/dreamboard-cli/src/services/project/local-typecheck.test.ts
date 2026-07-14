import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runLocalTypecheck } from "./local-typecheck.js";
import { scaffoldStaticWorkspace } from "./static-scaffold.js";

const TYPECHECK_FIXTURE_ROOT = path.resolve(
  import.meta.dir,
  "__fixtures__/static-typecheck",
);

async function seedDynamicFilesForTypecheck(tempRoot: string): Promise<void> {
  const fixtureFiles = [
    "shared/manifest.ts",
    "shared/ui-args.ts",
    "app/generated/guards.ts",
    "ui/App.tsx",
  ] as const;

  for (const relativePath of fixtureFiles) {
    const sourcePath = path.join(TYPECHECK_FIXTURE_ROOT, relativePath);
    const targetPath = path.join(tempRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, await Bun.file(sourcePath).text());
  }
}

test("runLocalTypecheck skips when workspace dependencies are not installed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-local-typecheck-"));
  const originalPath = process.env.PATH;

  try {
    await scaffoldStaticWorkspace(tempRoot, "new", { updateSdk: true });
    await seedDynamicFilesForTypecheck(tempRoot);

    process.env.PATH = "";

    const result = await runLocalTypecheck(tempRoot);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.output).toContain(
      "Skipping local typecheck: workspace dependencies are not installed",
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
}, 20_000);

test("runLocalTypecheck prefers project-local TypeScript without workspace symlinks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-local-typecheck-"));
  const localTscPath = path.join(
    tempRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );

  try {
    await mkdir(path.dirname(localTscPath), { recursive: true });

    await Bun.write(
      localTscPath,
      [
        "#!/usr/bin/env node",
        'process.stderr.write("LOCAL_TSC_SENTINEL\\n");',
        "process.exit(1);",
      ].join("\n"),
    );

    await expect(runLocalTypecheck(tempRoot)).resolves.toEqual({
      success: false,
      output: "LOCAL_TSC_SENTINEL",
    });

    await expect(
      lstat(path.join(tempRoot, "ui", "node_modules")),
    ).rejects.toBeDefined();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
