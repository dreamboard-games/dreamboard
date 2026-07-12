import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  bundleTypeScriptSourceWithSourceClosure,
  importBundledTypeScriptModuleText,
} from "../../utils/ts-module-loader.js";

const SCENARIO_SUFFIX = ".scenario.ts";
const SCENARIO_ROOT = path.join("test", "scenarios");
const SDK_TESTING_SPECIFIER = "@dreamboard-games/sdk/testing";
const SDK_PACKAGE_JSON_SPECIFIER = "@dreamboard-games/sdk/package.json";

const cliRequire = createRequire(import.meta.url);

// Trusted reducer code cannot read process.env. Preserve the existing host-side
// opt-in for authoring diagnostics while evaluating game and scenario source.
(globalThis as Record<string, unknown>).__DREAMBOARD_AUTHORING_WARNINGS__ =
  true;

export const NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR =
  "No scenarios found under test/scenarios/**/*.scenario.ts";

export type ScenarioLoaderErrorCode =
  | "DUPLICATE_SCENARIO_ID"
  | "INVALID_SCENARIO_EXPORT"
  | "INVALID_SCENARIO_SELECTOR"
  | "NO_SCENARIOS_FOUND"
  | "SCENARIO_LOAD_FAILED"
  | "SDK_VERSION_UNAVAILABLE";

export class ScenarioLoaderError extends Error {
  readonly code: ScenarioLoaderErrorCode;
  readonly scenarioPath?: string;
  readonly scenarioPaths?: readonly string[];
  readonly sourceDigest?: string;
  readonly sdkVersion?: string;
  readonly causeName?: string;
  readonly causeCode?: string;
  readonly validationPath?: string;

  constructor(options: {
    readonly code: ScenarioLoaderErrorCode;
    readonly message: string;
    readonly scenarioPath?: string;
    readonly scenarioPaths?: readonly string[];
    readonly sourceDigest?: string;
    readonly sdkVersion?: string;
    readonly causeName?: string;
    readonly causeCode?: string;
    readonly validationPath?: string;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ScenarioLoaderError";
    this.code = options.code;
    this.scenarioPath = options.scenarioPath;
    this.scenarioPaths = options.scenarioPaths;
    this.sourceDigest = options.sourceDigest;
    this.sdkVersion = options.sdkVersion;
    this.causeName = options.causeName;
    this.causeCode = options.causeCode;
    this.validationPath = options.validationPath;
  }
}

type ScenarioDefinitionLike = {
  readonly id: string;
  readonly then: (context: unknown) => void | Promise<void>;
};

type ScenarioReplayErrorConstructor = new (...args: never[]) => Error;

type LoadedBundleModule = {
  readonly game: unknown;
  readonly scenario: unknown;
  readonly replayDefinition: unknown;
  readonly replayScenario: (options: {
    readonly game: unknown;
    readonly scenario: unknown;
  }) => Promise<unknown>;
  readonly assertScenario: (options: {
    readonly replay: unknown;
    readonly assertion: (context: unknown) => void | Promise<void>;
  }) => Promise<void>;
  readonly ScenarioReplayError: ScenarioReplayErrorConstructor;
  readonly ScenarioDefinitionValidationError: ScenarioReplayErrorConstructor;
};

export type LoadedReducerNativeScenario = {
  readonly id: string;
  readonly scenarioPath: string;
  readonly sourceDigest: string;
  readonly sourceInputs: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly sdkVersion: string;
  readonly game: unknown;
  readonly definition: ScenarioDefinitionLike;
  readonly replayDefinition: unknown;
  readonly replayScenario: LoadedBundleModule["replayScenario"];
  readonly assertScenario: LoadedBundleModule["assertScenario"];
  readonly ScenarioReplayError: ScenarioReplayErrorConstructor;
  readonly ScenarioDefinitionValidationError: ScenarioReplayErrorConstructor;
};

export async function discoverReducerNativeScenarioPaths(options: {
  readonly projectRoot: string;
  readonly scenarioPath?: string;
}): Promise<readonly string[]> {
  const projectRoot = path.resolve(options.projectRoot);
  const scenarioRoot = path.join(projectRoot, SCENARIO_ROOT);

  if (options.scenarioPath) {
    return [
      await resolveScenarioSelector({
        projectRoot,
        scenarioRoot,
        selector: options.scenarioPath,
      }),
    ];
  }

  const discovered = await collectScenarioFiles(scenarioRoot);
  return discovered.sort((left, right) =>
    canonicalProjectPath(projectRoot, left).localeCompare(
      canonicalProjectPath(projectRoot, right),
    ),
  );
}

export async function loadReducerNativeScenarios(options: {
  readonly projectRoot: string;
  readonly scenarioPath?: string;
}): Promise<readonly LoadedReducerNativeScenario[]> {
  const projectRoot = path.resolve(options.projectRoot);
  const scenarioFiles = await discoverReducerNativeScenarioPaths({
    projectRoot,
    scenarioPath: options.scenarioPath,
  });
  if (scenarioFiles.length === 0) {
    throw new ScenarioLoaderError({
      code: "NO_SCENARIOS_FOUND",
      message: NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR,
    });
  }

  const sdkVersion = await resolveInstalledSdkVersion(projectRoot);
  const scenarios = await Promise.all(
    scenarioFiles.map((scenarioFile) =>
      loadReducerNativeScenario({
        projectRoot,
        scenarioFile,
        sdkVersion,
      }),
    ),
  );
  assertUniqueScenarioIds(scenarios);
  return scenarios;
}

async function loadReducerNativeScenario(options: {
  readonly projectRoot: string;
  readonly scenarioFile: string;
  readonly sdkVersion: string;
}): Promise<LoadedReducerNativeScenario> {
  const gamePath = path.join(options.projectRoot, "app", "game.ts");
  const scenarioPath = canonicalProjectPath(
    options.projectRoot,
    options.scenarioFile,
  );
  const source = buildSyntheticScenarioEntry({
    projectRoot: options.projectRoot,
    gamePath,
    scenarioFile: options.scenarioFile,
  });
  let sourceDigest: string | undefined;

  try {
    const bundled = await bundleTypeScriptSourceWithSourceClosure({
      projectRoot: options.projectRoot,
      source,
      sourcefile: "__dreamboard_scenario_entry__.ts",
    });
    sourceDigest = bundled.sourceDigest;
    const loaded = await importBundledTypeScriptModuleText<LoadedBundleModule>(
      bundled.bundleText,
      `scenario-${sanitizeModuleName(scenarioPath)}`,
    );
    const definition = requireScenarioDefinition(loaded.scenario, scenarioPath);
    requireBundleExports(loaded, scenarioPath);
    return {
      id: definition.id,
      scenarioPath,
      sourceDigest: bundled.sourceDigest,
      sourceInputs: bundled.inputs,
      sdkVersion: options.sdkVersion,
      game: loaded.game,
      definition,
      replayDefinition: loaded.replayDefinition,
      replayScenario: loaded.replayScenario,
      assertScenario: loaded.assertScenario,
      ScenarioReplayError: loaded.ScenarioReplayError,
      ScenarioDefinitionValidationError:
        loaded.ScenarioDefinitionValidationError,
    };
  } catch (error) {
    if (error instanceof ScenarioLoaderError) {
      throw error;
    }
    throw new ScenarioLoaderError({
      code: "SCENARIO_LOAD_FAILED",
      message: `Failed to load scenario '${scenarioPath}': ${errorMessage(error)}`,
      scenarioPath,
      sourceDigest,
      sdkVersion: options.sdkVersion,
      causeName: objectString(error, "name"),
      causeCode:
        objectString(error, "code") ?? objectString(error, "errorCode"),
      validationPath: objectString(error, "path"),
      cause: error,
    });
  }
}

function buildSyntheticScenarioEntry(options: {
  readonly projectRoot: string;
  readonly gamePath: string;
  readonly scenarioFile: string;
}): string {
  const gameSpecifier = localImportSpecifier(
    options.projectRoot,
    options.gamePath,
  );
  const scenarioSpecifier = localImportSpecifier(
    options.projectRoot,
    options.scenarioFile,
  );
  return [
    `import game from ${JSON.stringify(gameSpecifier)};`,
    `import scenario from ${JSON.stringify(scenarioSpecifier)};`,
    `import { assertScenario, replayScenario, ScenarioDefinitionValidationError, ScenarioReplayError, toScenarioReplayDefinition } from ${JSON.stringify(SDK_TESTING_SPECIFIER)};`,
    "const replayDefinition = toScenarioReplayDefinition(scenario);",
    "export { assertScenario, game, replayDefinition, replayScenario, scenario, ScenarioDefinitionValidationError, ScenarioReplayError };",
  ].join("\n");
}

function localImportSpecifier(projectRoot: string, filePath: string): string {
  const relative = canonicalProjectPath(projectRoot, filePath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function requireScenarioDefinition(
  value: unknown,
  scenarioPath: string,
): ScenarioDefinitionLike {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    !("then" in value) ||
    typeof value.then !== "function"
  ) {
    throw new ScenarioLoaderError({
      code: "INVALID_SCENARIO_EXPORT",
      message:
        `Scenario '${scenarioPath}' must default-export a scenario definition ` +
        "with a non-empty id and then assertion.",
      scenarioPath,
    });
  }
  return value as ScenarioDefinitionLike;
}

function requireBundleExports(
  loaded: LoadedBundleModule,
  scenarioPath: string,
): void {
  const requiredFunctions = [
    ["replayScenario", loaded.replayScenario],
    ["assertScenario", loaded.assertScenario],
    ["ScenarioReplayError", loaded.ScenarioReplayError],
    [
      "ScenarioDefinitionValidationError",
      loaded.ScenarioDefinitionValidationError,
    ],
  ] as const;
  const missing = requiredFunctions.find(
    ([, value]) => typeof value !== "function",
  );
  if (missing) {
    throw new ScenarioLoaderError({
      code: "SCENARIO_LOAD_FAILED",
      message:
        `Scenario '${scenarioPath}' resolved an SDK testing module without ` +
        `the required '${missing[0]}' export.`,
      scenarioPath,
    });
  }
}

function assertUniqueScenarioIds(
  scenarios: readonly LoadedReducerNativeScenario[],
): void {
  const firstPathById = new Map<string, string>();
  for (const scenario of scenarios) {
    const firstPath = firstPathById.get(scenario.id);
    if (firstPath) {
      const scenarioPaths = [firstPath, scenario.scenarioPath] as const;
      throw new ScenarioLoaderError({
        code: "DUPLICATE_SCENARIO_ID",
        message: `Duplicate scenario id '${scenario.id}' in '${firstPath}' and '${scenario.scenarioPath}'.`,
        scenarioPaths,
      });
    }
    firstPathById.set(scenario.id, scenario.scenarioPath);
  }
}

async function resolveScenarioSelector(options: {
  readonly projectRoot: string;
  readonly scenarioRoot: string;
  readonly selector: string;
}): Promise<string> {
  const canonicalSelector = options.selector.split(path.sep).join("/");
  if (path.isAbsolute(options.selector)) {
    throw new ScenarioLoaderError({
      code: "INVALID_SCENARIO_SELECTOR",
      message: `Scenario selector '${canonicalSelector}' must be project-relative.`,
      scenarioPath: canonicalSelector,
    });
  }
  const candidates = [
    path.resolve(options.projectRoot, options.selector),
    path.resolve(options.scenarioRoot, options.selector),
  ];
  const candidate = candidates.find((value) =>
    isWithinDirectory(options.scenarioRoot, value),
  );
  if (!candidate || !candidate.endsWith(SCENARIO_SUFFIX)) {
    throw new ScenarioLoaderError({
      code: "INVALID_SCENARIO_SELECTOR",
      message:
        `Scenario selector '${canonicalSelector}' must name a ` +
        `*.scenario.ts file under '${SCENARIO_ROOT.split(path.sep).join("/")}'.`,
      scenarioPath: canonicalSelector,
    });
  }
  try {
    if (!(await stat(candidate)).isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new ScenarioLoaderError({
      code: "INVALID_SCENARIO_SELECTOR",
      message: `Scenario selector '${canonicalSelector}' does not exist.`,
      scenarioPath: canonicalSelector,
      cause: error,
    });
  }
  return candidate;
}

async function collectScenarioFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectScenarioFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(SCENARIO_SUFFIX)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function resolveInstalledSdkVersion(
  projectRoot: string,
): Promise<string> {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  for (const requireFrom of [projectRequire, cliRequire]) {
    try {
      requireFrom.resolve(SDK_TESTING_SPECIFIER);
      const packageJsonPath = requireFrom.resolve(SDK_PACKAGE_JSON_SPECIFIER);
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      // Try the CLI's pinned SDK after the project-local dependency.
    }
  }
  throw new ScenarioLoaderError({
    code: "SDK_VERSION_UNAVAILABLE",
    message:
      "Unable to resolve the @dreamboard-games/sdk package used to evaluate scenarios.",
  });
}

function canonicalProjectPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function isWithinDirectory(directory: string, filePath: string): boolean {
  const relative = path.relative(directory, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sanitizeModuleName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}
