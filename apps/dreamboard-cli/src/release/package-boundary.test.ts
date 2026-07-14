import path from "node:path";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageRoot = path.resolve(import.meta.dir, "../..");

test("stage publish validates source version authority without npm metadata", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };

  const stagePublish = packageJson.scripts["stage:publish"];
  expect(stagePublish).toContain("pnpm run check:authoring-version-authority");
});
