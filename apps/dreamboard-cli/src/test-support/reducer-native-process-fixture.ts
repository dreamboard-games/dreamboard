import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureSourceRoot = fileURLToPath(
  new URL("./reducer-native-process-fixture/", import.meta.url),
);
const localRequire = createRequire(import.meta.url);

export type ReducerNativeProcessFixture = {
  readonly root: string;
  readonly home: string;
  readonly scenarioPath: "test/scenarios/increment.scenario.ts";
  cleanup(): Promise<void>;
};

export async function materializeReducerNativeProcessFixture(): Promise<ReducerNativeProcessFixture> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "dreamboard-test-family-"),
  );
  const root = path.join(temporaryRoot, "project");
  const home = path.join(temporaryRoot, "home");
  await Promise.all([
    cp(fixtureSourceRoot, root, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  const sdkPackageRoot = path.dirname(
    localRequire.resolve("@dreamboard-games/sdk/package.json"),
  );
  const zodPackageRoot = path.dirname(localRequire.resolve("zod/package.json"));
  const [sdkPackageJson, zodPackageJson] = await Promise.all([
    readPackageJson(path.join(sdkPackageRoot, "package.json")),
    readPackageJson(path.join(zodPackageRoot, "package.json")),
  ]);
  const dreamboardModules = path.join(
    root,
    "node_modules",
    "@dreamboard-games",
  );
  await Promise.all([
    mkdir(dreamboardModules, { recursive: true }),
    mkdir(path.join(root, ".dreamboard"), { recursive: true }),
  ]);
  await Promise.all([
    symlink(sdkPackageRoot, path.join(dreamboardModules, "sdk"), "junction"),
    symlink(zodPackageRoot, path.join(root, "node_modules", "zod"), "junction"),
    writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "dreamboard-test-family-fixture",
          private: true,
          type: "module",
          packageManager: "pnpm@10.4.1",
          dependencies: {
            "@dreamboard-games/sdk": sdkPackageJson.version,
            zod: zodPackageJson.version,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      path.join(root, ".dreamboard", "project.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          projectId: "test-family-fixture",
          slug: "test-family-fixture",
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      path.join(root, ".dreamboard", "state.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          bindings: {
            "fixture-deployment:fixture-owner": {
              deploymentId: "fixture-deployment",
              ownerScopeId: "fixture-owner",
              environment: "local",
              workspacePrepared: true,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);

  return {
    root,
    home,
    scenarioPath: "test/scenarios/increment.scenario.ts",
    cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
  };
}

async function readPackageJson(
  filePath: string,
): Promise<{ readonly version: string }> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`Package at '${filePath}' does not declare a version.`);
  }
  return { version: parsed.version };
}
