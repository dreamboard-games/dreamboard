import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  assertCliStaticScaffoldComplete,
  scaffoldStaticWorkspace,
} from "./static-scaffold.js";

const TYPECHECK_FIXTURE_ROOT = path.resolve(
  import.meta.dir,
  "__fixtures__/static-typecheck",
);
const CLI_NODE_MODULES = path.join(
  path.resolve(import.meta.dir, "../../.."),
  "node_modules",
);
const DEV_HOST_NODE_MODULES = path.join(
  path.resolve(import.meta.dir, "../../../../../packages/dev-host"),
  "node_modules",
);
const TSC_BIN = path.join(CLI_NODE_MODULES, ".bin", "tsc");

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

  await symlink(CLI_NODE_MODULES, path.join(tempRoot, "node_modules"));
  await symlink(
    DEV_HOST_NODE_MODULES,
    path.join(tempRoot, "ui", "node_modules"),
  );
}

function runTypecheck(tempRoot: string, projectPath: string): void {
  const result = Bun.spawnSync({
    cmd: [TSC_BIN, "--noEmit", "-p", projectPath],
    cwd: tempRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode === 0) {
    return;
  }

  const decoder = new TextDecoder();
  throw new Error(
    `Typecheck failed for ${projectPath}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
  );
}

test("scaffolds static framework files locally", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");

    expect(
      await Bun.file(path.join(tempRoot, "app", "tsconfig.json")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(path.join(tempRoot, "ui", "index.tsx")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(path.join(tempRoot, "ui", "style.css")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        path.join(
          tempRoot,
          "test",
          "scenarios",
          "smoke-initial-turn.scenario.ts",
        ),
      ).exists(),
    ).toBe(true);
    expect(
      await stat(path.join(tempRoot, "test", "bases")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(path.join(tempRoot, "test", "generated")).catch(() => null),
    ).toBeNull();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("ignores local dependency installs in authored Git state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");

    const gitignore = await Bun.file(path.join(tempRoot, ".gitignore")).text();
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("ui/node_modules/");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fails compile preflight when shared static files are missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));
  const missingFilePath = path.join(tempRoot, "app", "tsconfig.json");

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");
    await rm(missingFilePath, { force: true });

    await expect(assertCliStaticScaffoldComplete(tempRoot)).rejects.toThrow(
      "dreamboard project create or dreamboard project clone",
    );
    await expect(assertCliStaticScaffoldComplete(tempRoot)).rejects.toThrow(
      "app/tsconfig.json",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("removes stale Dreamboard registry configuration", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));

  try {
    await Bun.write(
      path.join(tempRoot, ".npmrc"),
      "@dreamboard-games:registry=http://127.0.0.1:4873\n",
    );
    await scaffoldStaticWorkspace(tempRoot, "update");

    expect(await Bun.file(path.join(tempRoot, ".npmrc")).exists()).toBe(false);
    await expect(assertCliStaticScaffoldComplete(tempRoot)).resolves.toBe(
      undefined,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preserves unrelated npm configuration when removing the stale Dreamboard registry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));
  const npmrcPath = path.join(tempRoot, ".npmrc");

  try {
    await Bun.write(
      npmrcPath,
      "registry=https://registry.example.com/\n@dreamboard-games:registry=http://127.0.0.1:4873\n//registry.example.com/:_authToken=${NPM_TOKEN}\n",
    );
    await scaffoldStaticWorkspace(tempRoot, "update");

    expect(await Bun.file(npmrcPath).text()).toBe(
      "registry=https://registry.example.com/\n//registry.example.com/:_authToken=${NPM_TOKEN}\n",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fails compile preflight when ui scaffold files are missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));
  const missingFilePath = path.join(tempRoot, "ui", "index.tsx");

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");
    await rm(missingFilePath, { force: true });

    await expect(assertCliStaticScaffoldComplete(tempRoot)).rejects.toThrow(
      "ui/index.tsx",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fails compile preflight when cli static files are deleted locally", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");

    await expect(
      assertCliStaticScaffoldComplete(tempRoot, ["ui/index.tsx"]),
    ).rejects.toThrow("deleted");
    await expect(
      assertCliStaticScaffoldComplete(tempRoot, ["ui/index.tsx"]),
    ).rejects.toThrow("dreamboard project create or dreamboard project clone");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("refreshes generated testing-types on update when the file is still framework-owned", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));
  const testingTypesPath = path.join(tempRoot, "test", "testing-types.ts");

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");
    await Bun.write(
      testingTypesPath,
      `// Generated by dreamboard — do not edit by hand.\nexport function defineScenario(scenario) { return scenario; }\n`,
    );

    await scaffoldStaticWorkspace(tempRoot, "update");

    const refreshed = await Bun.file(testingTypesPath).text();
    expect(refreshed).toContain('import game from "../app/game";');
    expect(refreshed).toContain("createScenarioAuthoring(game)");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("refreshes the generated smoke scenario without assuming interactions are empty", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));
  const scenarioPath = path.join(
    tempRoot,
    "test",
    "scenarios",
    "smoke-initial-turn.scenario.ts",
  );

  try {
    await scaffoldStaticWorkspace(tempRoot, "new");
    await Bun.write(
      scenarioPath,
      `// Generated by dreamboard scaffold.\nthrow new Error("stale scenario");\n`,
    );

    await scaffoldStaticWorkspace(tempRoot, "update");

    const refreshed = await Bun.file(scenarioPath).text();
    expect(refreshed).toContain("setup: { players: 4, seed: 1337 }");
    expect(refreshed).toContain("given: []");
    expect(refreshed).toContain("when: []");
    expect(refreshed).toContain("expect(state()).toBeDefined()");
    expect(refreshed).not.toContain("stale scenario");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("materialized static scaffold typechecks for app and ui targets", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-static-scaffold-"));

  try {
    if (!(await Bun.file(TSC_BIN).exists())) {
      return;
    }
    await scaffoldStaticWorkspace(tempRoot, "new");
    await seedDynamicFilesForTypecheck(tempRoot);

    runTypecheck(tempRoot, "app/tsconfig.json");
    runTypecheck(tempRoot, "ui/tsconfig.json");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}, 20_000);
