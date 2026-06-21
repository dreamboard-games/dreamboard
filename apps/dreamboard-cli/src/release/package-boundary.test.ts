import path from "node:path";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageRoot = path.resolve(import.meta.dir, "../..");
const repoRoot = path.resolve(packageRoot, "../..");

test("public package boundary excludes authoring compatibility internals", async () => {
  const [rootPackageJson, stagePublish, tsupConfig] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(packageRoot, "scripts/stage-publish.ts"), "utf8"),
    readFile(path.join(packageRoot, "tsup.config.ts"), "utf8"),
  ]);

  expect(rootPackageJson).not.toContain("authoring:compat");
  expect(stagePublish).not.toContain("authoring-compatibility-internal");
  expect(tsupConfig).not.toContain("authoring-compatibility-internal");
});
