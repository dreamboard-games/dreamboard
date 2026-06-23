import path from "node:path";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageRoot = path.resolve(import.meta.dir, "../..");

test("stage publish checks npm freshness before version authority", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };

  const stagePublish = packageJson.scripts["stage:publish"];
  expect(stagePublish).toContain(
    "pnpm run check:authoring-release-set-npm-freshness",
  );
  expect(
    stagePublish.indexOf("pnpm run check:authoring-release-set-npm-freshness"),
  ).toBeLessThan(
    stagePublish.indexOf("pnpm run check:authoring-version-authority"),
  );
});
