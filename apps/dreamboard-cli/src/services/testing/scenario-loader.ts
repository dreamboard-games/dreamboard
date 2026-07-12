import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  bundleTypeScriptSourceWithSourceClosure,
  importBundledTypeScriptModuleText,
} from "../../utils/ts-module-loader.js";

const SCENARIO_SUFFIX = ".scenario.ts";
const SCENARIO_ROOT = path.join("test", "scenarios");
const SDK_TESTING_SPECIFIER = "@dreamboard-games/sdk/testing";
const SDK_TESTING_RUNTIME_SPECIFIER = "@dreamboard-games/sdk/testing-runtime";
const SDK_TESTING_COMPILER_SPECIFIER = "@dreamboard-games/sdk/testing-compiler";
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

export type ScenarioSelectorReason =
  | "notFound"
  | "outsideRoot"
  | "invalidExtension";

export class ScenarioLoaderError extends Error {
  readonly code: ScenarioLoaderErrorCode;
  readonly scenarioId?: string;
  readonly scenarioPath?: string;
  readonly scenarioPaths?: readonly string[];
  readonly selectorReason?: ScenarioSelectorReason;
  readonly sourceDigest?: string;
  readonly sdkVersion?: string;
  readonly causeName?: string;
  readonly causeCode?: string;
  readonly validationPath?: string;

  constructor(options: {
    readonly code: ScenarioLoaderErrorCode;
    readonly message: string;
    readonly scenarioId?: string;
    readonly scenarioPath?: string;
    readonly scenarioPaths?: readonly string[];
    readonly selectorReason?: ScenarioSelectorReason;
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
    this.scenarioId = options.scenarioId;
    this.scenarioPath = options.scenarioPath;
    this.scenarioPaths = options.scenarioPaths;
    this.selectorReason = options.selectorReason;
    this.sourceDigest = options.sourceDigest;
    this.sdkVersion = options.sdkVersion;
    this.causeName = options.causeName;
    this.causeCode = options.causeCode;
    this.validationPath = options.validationPath;
  }
}

export type ScenarioCommandLike = {
  readonly actor: { readonly seat: number };
  readonly interactionId: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type ScenarioDefinitionLike = {
  readonly id: string;
  readonly setup: {
    readonly players: number;
    readonly seed: number;
    readonly setupProfileId?: string | null;
  };
  readonly given: readonly ScenarioCommandLike[];
  readonly when: readonly ScenarioCommandLike[];
  readonly then: (context: unknown) => void | Promise<void>;
};

export type ScenarioReplayDefinitionLike = Omit<ScenarioDefinitionLike, "then">;

export type CompiledScenarioReplayLike = {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly path: string;
    readonly sourceDigest: `sha256:${string}`;
  };
  readonly definition: ScenarioReplayDefinitionLike;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly expected: {
    readonly checkpointDigest: `sha256:${string}`;
    readonly publicProjectionDigest: `sha256:${string}`;
  };
};

export type ScenarioCheckpointLike =
  | { readonly segment: "setup"; readonly completed: 0 }
  | { readonly segment: "given" | "when"; readonly completed: number };

export type ScenarioProjectionParityLike = {
  readonly perspective: "spectator" | { readonly seat: number };
  readonly flow: {
    readonly phase: string;
    readonly step: string | null;
    readonly activeSeats: readonly number[];
    readonly pendingSeats: readonly number[];
    readonly continuationWaiterSeats: readonly number[];
    readonly blockedBy: readonly {
      readonly actorSeat: number;
      readonly blockerSeats: readonly number[];
    }[];
  };
  readonly view: unknown;
  readonly interactions: readonly {
    readonly actorSeat: number;
    readonly interactionId: string;
    readonly availability: {
      readonly status: string;
      readonly code?: string;
      readonly reason?: string;
    };
    readonly inputs: readonly {
      readonly key: string;
      readonly kind: string;
      readonly eligibleCount: number | "lazy";
    }[];
  }[];
};

export type InspectScenarioResultLike = {
  readonly schemaVersion: 1;
  readonly node: {
    readonly checkpoint: ScenarioCheckpointLike;
    readonly checkpointDigest: string;
    readonly flow: {
      readonly phase: string;
    };
  };
};

type ScenarioReplayErrorConstructor = new (...args: never[]) => Error;

type LoadedBundleModule = {
  readonly game: unknown;
  readonly scenario: unknown;
  readonly toScenarioReplayDefinition: (scenario: unknown) => unknown;
  readonly replayScenario: (options: {
    readonly game: unknown;
    readonly scenario: unknown;
  }) => Promise<unknown>;
  readonly inspectScenario: (options: {
    readonly game: unknown;
    readonly scenario: unknown;
    readonly identity: {
      readonly id: string;
      readonly path: string;
      readonly sourceDigest: string;
    };
    readonly perspective:
      | { readonly kind: "player"; readonly seat: number }
      | { readonly kind: "spectator" };
    readonly at?: ScenarioCheckpointLike;
    readonly seed?: number;
  }) => Promise<InspectScenarioResultLike>;
  readonly exploreScenario: (options: {
    readonly game: unknown;
    readonly scenario: unknown;
    readonly identity: {
      readonly id: string;
      readonly path: string;
      readonly sourceDigest: string;
    };
    readonly perspective:
      | { readonly kind: "player"; readonly seat: number }
      | { readonly kind: "spectator" };
    readonly at?: ScenarioCheckpointLike;
    readonly seed?: number;
    readonly seedRange?: { readonly start: number; readonly end: number };
    readonly limit?: number;
    readonly maxEvaluations?: number;
    readonly cursor?: string;
  }) => Promise<unknown>;
  readonly resolveScenarioCommandParams: (options: {
    readonly game: unknown;
    readonly phase: string;
    readonly interactionId: string;
    readonly params: unknown;
    readonly playerIds: readonly string[];
    readonly path: string;
  }) => Record<string, unknown>;
  readonly scenarioProjectionParityFromInspectNode: (
    node: InspectScenarioResultLike["node"],
  ) => ScenarioProjectionParityLike;
  readonly scenarioProjectionInputMetadata: (input: {
    readonly key: string;
    readonly kind: string;
    readonly domain: unknown;
  }) => {
    readonly key: string;
    readonly kind: string;
    readonly eligibleCount: number | "lazy";
  };
  readonly digestScenarioProjection: (
    projection: ScenarioProjectionParityLike,
  ) => string;
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
  readonly replayDefinition: ScenarioReplayDefinitionLike;
  readonly replayScenario: LoadedBundleModule["replayScenario"];
  readonly inspectScenario: LoadedBundleModule["inspectScenario"];
  readonly exploreScenario: LoadedBundleModule["exploreScenario"];
  readonly resolveScenarioCommandParams: LoadedBundleModule["resolveScenarioCommandParams"];
  readonly scenarioProjectionParityFromInspectNode: LoadedBundleModule["scenarioProjectionParityFromInspectNode"];
  readonly scenarioProjectionInputMetadata: LoadedBundleModule["scenarioProjectionInputMetadata"];
  readonly digestScenarioProjection: LoadedBundleModule["digestScenarioProjection"];
  readonly assertScenario: LoadedBundleModule["assertScenario"];
  readonly ScenarioReplayError: ScenarioReplayErrorConstructor;
  readonly ScenarioDefinitionValidationError: ScenarioReplayErrorConstructor;
};

type ScenarioCompilerModule = {
  readonly compileScenarioReplay?: (options: {
    readonly scenarioPath: string;
    readonly at?: ScenarioCheckpointLike;
  }) => Promise<unknown>;
};

export async function compileReducerNativeScenarioReplay(options: {
  readonly projectRoot: string;
  readonly scenarioPath: string;
  readonly at?: ScenarioCheckpointLike;
}): Promise<CompiledScenarioReplayLike> {
  const projectRoot = path.resolve(options.projectRoot);
  const scenarioFile = await resolveScenarioSelector({
    projectRoot,
    scenarioRoot: path.join(projectRoot, SCENARIO_ROOT),
    selector: options.scenarioPath,
  });
  const sdkVersion = await resolveInstalledSdkVersion(projectRoot);
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  let compilerPath: string;
  try {
    compilerPath = projectRequire.resolve(SDK_TESTING_COMPILER_SPECIFIER);
  } catch (error) {
    throw new ScenarioLoaderError({
      code: "SDK_VERSION_UNAVAILABLE",
      message:
        `Installed @dreamboard-games/sdk ${sdkVersion} does not export ` +
        `'${SDK_TESTING_COMPILER_SPECIFIER}'.`,
      scenarioPath: options.scenarioPath,
      sdkVersion,
      cause: error,
    });
  }
  const compiler = (await import(
    pathToFileURL(compilerPath).href
  )) as ScenarioCompilerModule;
  if (typeof compiler.compileScenarioReplay !== "function") {
    throw new ScenarioLoaderError({
      code: "SDK_VERSION_UNAVAILABLE",
      message:
        `Installed @dreamboard-games/sdk ${sdkVersion} has no ` +
        "compileScenarioReplay export.",
      scenarioPath: options.scenarioPath,
      sdkVersion,
    });
  }
  const compiled = await compiler.compileScenarioReplay({
    scenarioPath: scenarioFile,
    ...(options.at === undefined ? {} : { at: options.at }),
  });
  return requireCompiledScenarioReplay(compiled, options.scenarioPath);
}

type EvaluatedReducerNativeScenario = {
  readonly id: string;
  readonly scenarioPath: string;
  readonly sourceDigest: string;
  readonly sourceInputs: LoadedReducerNativeScenario["sourceInputs"];
  readonly sdkVersion: string;
  readonly definition: ScenarioDefinitionLike;
  readonly bundleModule: LoadedBundleModule;
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
  const selectedScenarioFile = options.scenarioPath
    ? (
        await discoverReducerNativeScenarioPaths({
          projectRoot,
          scenarioPath: options.scenarioPath,
        })
      )[0]
    : undefined;
  const scenarioFiles = await discoverReducerNativeScenarioPaths({
    projectRoot,
  });
  if (scenarioFiles.length === 0) {
    throw new ScenarioLoaderError({
      code: "NO_SCENARIOS_FOUND",
      message: NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR,
    });
  }

  const sdkVersion = await resolveInstalledSdkVersion(projectRoot);
  const evaluatedScenarios = await Promise.all(
    scenarioFiles.map((scenarioFile) =>
      evaluateReducerNativeScenario({
        projectRoot,
        scenarioFile,
        sdkVersion,
      }),
    ),
  );
  assertUniqueScenarioIds(evaluatedScenarios);
  const selectedScenarioPath = selectedScenarioFile
    ? canonicalProjectPath(projectRoot, selectedScenarioFile)
    : undefined;
  const selectedScenarios = selectedScenarioPath
    ? evaluatedScenarios.filter(
        (scenario) => scenario.scenarioPath === selectedScenarioPath,
      )
    : evaluatedScenarios;
  if (selectedScenarioPath && selectedScenarios.length !== 1) {
    throw invalidScenarioSelector({
      selector: selectedScenarioPath,
      reason: "notFound",
      detail: "was not present in the discovered scenario workspace",
    });
  }
  return selectedScenarios.map(materializeReducerNativeScenario);
}

async function evaluateReducerNativeScenario(options: {
  readonly projectRoot: string;
  readonly scenarioFile: string;
  readonly sdkVersion: string;
}): Promise<EvaluatedReducerNativeScenario> {
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
      definition,
      bundleModule: loaded,
    };
  } catch (error) {
    if (error instanceof ScenarioLoaderError) {
      throw error;
    }
    throw scenarioLoadError({
      scenarioPath,
      sourceDigest,
      sdkVersion: options.sdkVersion,
      error,
    });
  }
}

function materializeReducerNativeScenario(
  evaluated: EvaluatedReducerNativeScenario,
): LoadedReducerNativeScenario {
  const loaded = evaluated.bundleModule;
  try {
    return {
      id: evaluated.id,
      scenarioPath: evaluated.scenarioPath,
      sourceDigest: evaluated.sourceDigest,
      sourceInputs: evaluated.sourceInputs,
      sdkVersion: evaluated.sdkVersion,
      game: loaded.game,
      definition: evaluated.definition,
      replayDefinition: loaded.toScenarioReplayDefinition(
        evaluated.definition,
      ) as ScenarioReplayDefinitionLike,
      replayScenario: loaded.replayScenario,
      inspectScenario: loaded.inspectScenario,
      exploreScenario: loaded.exploreScenario,
      resolveScenarioCommandParams: loaded.resolveScenarioCommandParams,
      scenarioProjectionParityFromInspectNode:
        loaded.scenarioProjectionParityFromInspectNode,
      scenarioProjectionInputMetadata: loaded.scenarioProjectionInputMetadata,
      digestScenarioProjection: loaded.digestScenarioProjection,
      assertScenario: loaded.assertScenario,
      ScenarioReplayError: loaded.ScenarioReplayError,
      ScenarioDefinitionValidationError:
        loaded.ScenarioDefinitionValidationError,
    };
  } catch (error) {
    throw scenarioLoadError({
      scenarioPath: evaluated.scenarioPath,
      sourceDigest: evaluated.sourceDigest,
      sdkVersion: evaluated.sdkVersion,
      error,
    });
  }
}

function scenarioLoadError(options: {
  readonly scenarioPath: string;
  readonly sourceDigest?: string;
  readonly sdkVersion: string;
  readonly error: unknown;
}): ScenarioLoaderError {
  return new ScenarioLoaderError({
    code: "SCENARIO_LOAD_FAILED",
    message: `Failed to load scenario '${options.scenarioPath}': ${errorMessage(options.error)}`,
    scenarioPath: options.scenarioPath,
    sourceDigest: options.sourceDigest,
    sdkVersion: options.sdkVersion,
    causeName: objectString(options.error, "name"),
    causeCode:
      objectString(options.error, "code") ??
      objectString(options.error, "errorCode"),
    validationPath: objectString(options.error, "path"),
    cause: options.error,
  });
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
    `import * as scenarioModule from ${JSON.stringify(scenarioSpecifier)};`,
    `import { assertScenario, exploreScenario, inspectScenario, replayScenario, ScenarioDefinitionValidationError, ScenarioReplayError, toScenarioReplayDefinition } from ${JSON.stringify(SDK_TESTING_SPECIFIER)};`,
    `import { digestScenarioProjection, resolveScenarioCommandParams, scenarioProjectionInputMetadata, scenarioProjectionParityFromInspectNode } from ${JSON.stringify(SDK_TESTING_RUNTIME_SPECIFIER)};`,
    'const scenario = Reflect.get(scenarioModule, "default");',
    "export { assertScenario, digestScenarioProjection, exploreScenario, game, inspectScenario, replayScenario, resolveScenarioCommandParams, scenario, scenarioProjectionInputMetadata, scenarioProjectionParityFromInspectNode, ScenarioDefinitionValidationError, ScenarioReplayError, toScenarioReplayDefinition };",
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

function requireCompiledScenarioReplay(
  value: unknown,
  scenarioPath: string,
): CompiledScenarioReplayLike {
  const compiled = value as Partial<CompiledScenarioReplayLike> | null;
  const definition = compiled?.definition as
    | Partial<ScenarioReplayDefinitionLike>
    | undefined;
  const checkpoint = compiled?.checkpoint as
    | Partial<ScenarioCheckpointLike>
    | undefined;
  if (
    typeof compiled !== "object" ||
    compiled === null ||
    compiled.schemaVersion !== 1 ||
    typeof compiled.scenario?.path !== "string" ||
    !isSha256(compiled.scenario.sourceDigest) ||
    typeof definition?.id !== "string" ||
    typeof definition.setup?.players !== "number" ||
    typeof definition.setup.seed !== "number" ||
    !Array.isArray(definition.given) ||
    !Array.isArray(definition.when) ||
    !isScenarioCheckpoint(checkpoint) ||
    !isSha256(compiled.expected?.checkpointDigest) ||
    !isSha256(compiled.expected.publicProjectionDigest)
  ) {
    throw new ScenarioLoaderError({
      code: "SCENARIO_LOAD_FAILED",
      message: `Scenario compiler returned an invalid schema-v1 replay for '${scenarioPath}'.`,
      scenarioPath,
    });
  }
  return compiled as CompiledScenarioReplayLike;
}

function isScenarioCheckpoint(
  value: Partial<ScenarioCheckpointLike> | undefined,
): value is ScenarioCheckpointLike {
  if (value?.segment === "setup") return value.completed === 0;
  return (
    (value?.segment === "given" || value?.segment === "when") &&
    Number.isSafeInteger(value.completed) &&
    (value.completed ?? -1) >= 0
  );
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function requireBundleExports(
  loaded: LoadedBundleModule,
  scenarioPath: string,
): void {
  const requiredFunctions = [
    ["toScenarioReplayDefinition", loaded.toScenarioReplayDefinition],
    ["replayScenario", loaded.replayScenario],
    ["assertScenario", loaded.assertScenario],
    ["inspectScenario", loaded.inspectScenario],
    ["exploreScenario", loaded.exploreScenario],
    ["resolveScenarioCommandParams", loaded.resolveScenarioCommandParams],
    [
      "scenarioProjectionParityFromInspectNode",
      loaded.scenarioProjectionParityFromInspectNode,
    ],
    ["scenarioProjectionInputMetadata", loaded.scenarioProjectionInputMetadata],
    ["digestScenarioProjection", loaded.digestScenarioProjection],
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
  scenarios: readonly Pick<
    EvaluatedReducerNativeScenario,
    "id" | "scenarioPath"
  >[],
): void {
  const pathsById = new Map<string, string[]>();
  for (const scenario of scenarios) {
    const paths = pathsById.get(scenario.id) ?? [];
    paths.push(scenario.scenarioPath);
    pathsById.set(scenario.id, paths);
  }

  for (const [scenarioId, scenarioPaths] of pathsById) {
    if (scenarioPaths.length < 2) {
      continue;
    }
    const orderedPaths = [...scenarioPaths].sort((left, right) =>
      left.localeCompare(right),
    );
    throw new ScenarioLoaderError({
      code: "DUPLICATE_SCENARIO_ID",
      message: `Duplicate scenario id '${scenarioId}' in ${orderedPaths
        .map((scenarioPath) => `'${scenarioPath}'`)
        .join(", ")}.`,
      scenarioId,
      scenarioPaths: orderedPaths,
    });
  }
}

async function resolveScenarioSelector(options: {
  readonly projectRoot: string;
  readonly scenarioRoot: string;
  readonly selector: string;
}): Promise<string> {
  const canonicalSelector = options.selector.replaceAll("\\", "/");
  const normalizedSelector = path.posix.normalize(canonicalSelector);
  const scenarioRootPrefix = `${SCENARIO_ROOT.split(path.sep).join("/")}/`;
  const selectorSegments = canonicalSelector.split("/");
  if (
    canonicalSelector === "" ||
    canonicalSelector.includes("\0") ||
    path.isAbsolute(options.selector) ||
    path.posix.isAbsolute(canonicalSelector) ||
    path.win32.isAbsolute(options.selector) ||
    normalizedSelector !== canonicalSelector ||
    selectorSegments.includes("..") ||
    !canonicalSelector.startsWith(scenarioRootPrefix)
  ) {
    throw invalidScenarioSelector({
      selector: canonicalSelector,
      reason: "outsideRoot",
      detail: `must be a normalized project-relative path under '${SCENARIO_ROOT.split(path.sep).join("/")}'`,
    });
  }
  if (!canonicalSelector.endsWith(SCENARIO_SUFFIX)) {
    throw invalidScenarioSelector({
      selector: canonicalSelector,
      reason: "invalidExtension",
      detail: `must end with '${SCENARIO_SUFFIX}'`,
    });
  }

  const candidate = path.resolve(options.projectRoot, ...selectorSegments);
  if (!isWithinDirectory(options.scenarioRoot, candidate)) {
    throw invalidScenarioSelector({
      selector: canonicalSelector,
      reason: "outsideRoot",
      detail: `must remain under '${SCENARIO_ROOT.split(path.sep).join("/")}'`,
    });
  }

  try {
    const candidateStats = await lstat(candidate);
    const resolvedProjectRoot = await realpath(options.projectRoot);
    const resolvedScenarioRoot = await realpath(options.scenarioRoot);
    const resolvedCandidate = await realpath(candidate);
    const expectedResolvedCandidate = path.resolve(
      resolvedProjectRoot,
      ...selectorSegments,
    );
    if (
      !isWithinDirectory(resolvedProjectRoot, resolvedCandidate) ||
      !isWithinDirectory(resolvedScenarioRoot, resolvedCandidate) ||
      resolvedCandidate !== expectedResolvedCandidate
    ) {
      throw invalidScenarioSelector({
        selector: canonicalSelector,
        reason: "outsideRoot",
        detail: "resolves outside the canonical project scenario tree",
      });
    }
    if (!candidateStats.isFile()) {
      throw invalidScenarioSelector({
        selector: canonicalSelector,
        reason: "notFound",
        detail: "does not name a regular scenario file",
      });
    }
  } catch (error) {
    if (error instanceof ScenarioLoaderError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      throw invalidScenarioSelector({
        selector: canonicalSelector,
        reason: "notFound",
        detail: "does not exist",
        cause: error,
      });
    }
    throw error;
  }
  return candidate;
}

function invalidScenarioSelector(options: {
  readonly selector: string;
  readonly reason: ScenarioSelectorReason;
  readonly detail: string;
  readonly cause?: unknown;
}): ScenarioLoaderError {
  return new ScenarioLoaderError({
    code: "INVALID_SCENARIO_SELECTOR",
    message: `Scenario selector '${options.selector}' ${options.detail}.`,
    scenarioPath: options.selector,
    selectorReason: options.reason,
    cause: options.cause,
  });
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
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
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
