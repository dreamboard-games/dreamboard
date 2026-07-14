import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleTypeScriptModuleWithSourceClosure } from "./ts-module-loader.js";
import { bundleTypeScriptSourceWithSourceClosure } from "./ts-module-loader.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createProject(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `dreamboard-${label}-`));
  roots.push(root);
  await mkdir(path.join(root, "test", "scenarios"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: label, type: "module" }),
  );
  await writeFile(
    path.join(root, "test", "helper.ts"),
    'export const commands = [{ interactionId: "pass", params: {} }];\n',
  );
  await writeFile(
    path.join(root, "test", "scenarios", "sample.scenario.ts"),
    'import { commands } from "../helper.ts";\nexport default { id: "sample", commands };\n',
  );
  return root;
}

describe("bundleTypeScriptModuleWithSourceClosure", () => {
  test("is path-independent and changes with an imported helper", async () => {
    const firstRoot = await createProject("first");
    const secondRoot = await createProject("second");
    const firstEntry = path.join(
      firstRoot,
      "test",
      "scenarios",
      "sample.scenario.ts",
    );
    const secondEntry = path.join(
      secondRoot,
      "test",
      "scenarios",
      "sample.scenario.ts",
    );

    const first = await bundleTypeScriptModuleWithSourceClosure(firstEntry, {
      projectRoot: firstRoot,
    });
    const second = await bundleTypeScriptModuleWithSourceClosure(secondEntry, {
      projectRoot: secondRoot,
    });
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(first.inputs.map((input) => input.path)).toEqual([
      "test/helper.ts",
      "test/scenarios/sample.scenario.ts",
    ]);

    await writeFile(
      path.join(secondRoot, "test", "helper.ts"),
      'export const commands = [{ interactionId: "wait", params: {} }];\n',
    );
    const changed = await bundleTypeScriptModuleWithSourceClosure(secondEntry, {
      projectRoot: secondRoot,
    });
    expect(changed.sourceDigest).not.toBe(first.sourceDigest);
  });

  test("excludes the synthetic entry while retaining imported local source", async () => {
    const root = await createProject("synthetic");
    const bundled = await bundleTypeScriptSourceWithSourceClosure({
      projectRoot: root,
      source: [
        'import scenario from "./test/scenarios/sample.scenario.ts";',
        "export { scenario };",
      ].join("\n"),
    });

    expect(bundled.inputs.map((input) => input.path)).toEqual([
      "test/helper.ts",
      "test/scenarios/sample.scenario.ts",
    ]);
  });
});
