import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ScenarioLoaderError,
  discoverReducerNativeScenarioPaths,
  loadReducerNativeScenarios,
} from "./scenario-loader.js";
import {
  exploreReducerNativeScenario,
  inspectReducerNativeScenario,
} from "./scenario-inspection-service.js";
import { runReducerNativeScenarios } from "./scenario-test-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("scenario loader", () => {
  test("discovers recursively in canonical order and accepts a path selector", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "z-last.scenario.ts", { id: "last" });
    await writeScenario(root, "nested/a-first.scenario.ts", { id: "first" });
    await writeFile(
      path.join(root, "test", "scenarios", "ignored.ts"),
      "export default {};\n",
    );

    const discovered = await discoverReducerNativeScenarioPaths({
      projectRoot: root,
    });
    expect(discovered.map((file) => relative(root, file))).toEqual([
      "test/scenarios/nested/a-first.scenario.ts",
      "test/scenarios/z-last.scenario.ts",
    ]);

    const selected = await discoverReducerNativeScenarioPaths({
      projectRoot: root,
      scenarioPath: "test/scenarios/nested/a-first.scenario.ts",
    });
    expect(selected.map((file) => relative(root, file))).toEqual([
      "test/scenarios/nested/a-first.scenario.ts",
    ]);
  });

  test("evaluates game, scenario, and replay helpers in one SDK bundle", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "passes.scenario.ts", { id: "passes" });

    const summary = await runReducerNativeScenarios({ projectRoot: root });

    expect(summary).toMatchObject({
      sdkVersion: "9.8.7-fixture",
      passed: 1,
      failed: 0,
      results: [
        {
          id: "passes",
          scenarioPath: "test/scenarios/passes.scenario.ts",
          sdkVersion: "9.8.7-fixture",
          success: true,
        },
      ],
    });
    expect(summary.results[0]?.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const [loaded] = await loadReducerNativeScenarios({ projectRoot: root });
    expect(loaded?.sourceInputs.map((input) => input.path)).toEqual([
      "app/game.ts",
      "test/scenarios/passes.scenario.ts",
      "test/testing-types.ts",
    ]);
    expect(
      loaded?.sourceInputs.some((input) => input.path.includes("node_modules")),
    ).toBe(false);
  });

  test("returns exactly the selected workspace scenario", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "first.scenario.ts", { id: "first" });
    await writeScenario(root, "nested/selected.scenario.ts", {
      id: "selected",
    });

    const loaded = await loadReducerNativeScenarios({
      projectRoot: root,
      scenarioPath: "test/scenarios/nested/selected.scenario.ts",
    });

    expect(loaded.map((scenario) => scenario.id)).toEqual(["selected"]);
    expect(loaded.map((scenario) => scenario.scenarioPath)).toEqual([
      "test/scenarios/nested/selected.scenario.ts",
    ]);
  });

  test("source digest includes assertion helpers but not the SDK package", async () => {
    const root = await createScenarioProject();
    await writeFile(
      path.join(root, "test", "assertion-helper.ts"),
      'export const expected = "first";\n',
    );
    await writeScenario(root, "closure.scenario.ts", {
      id: "closure",
      helperImport: true,
    });

    const [before] = await loadReducerNativeScenarios({ projectRoot: root });
    await writeFile(
      path.join(root, "test", "assertion-helper.ts"),
      'export const expected = "second";\n',
    );
    const [after] = await loadReducerNativeScenarios({ projectRoot: root });

    expect(before?.sourceInputs.map((input) => input.path)).toContain(
      "test/assertion-helper.ts",
    );
    expect(after?.sourceDigest).not.toBe(before?.sourceDigest);
    expect(after?.sdkVersion).toBe(before?.sdkVersion);
  });

  test("rejects duplicate ids across the workspace with authored id and canonical paths", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "first.scenario.ts", { id: "duplicate" });
    await writeScenario(root, "nested/second.scenario.ts", {
      id: "duplicate",
    });

    try {
      await loadReducerNativeScenarios({
        projectRoot: root,
        scenarioPath: "test/scenarios/first.scenario.ts",
      });
      throw new Error("expected duplicate scenario id to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioLoaderError);
      expect(error).toMatchObject({
        code: "DUPLICATE_SCENARIO_ID",
        scenarioId: "duplicate",
        scenarioPaths: [
          "test/scenarios/first.scenario.ts",
          "test/scenarios/nested/second.scenario.ts",
        ],
      });
      expect((error as Error).message).toContain(
        "test/scenarios/first.scenario.ts",
      );
      expect((error as Error).message).toContain(
        "test/scenarios/nested/second.scenario.ts",
      );
    }
  });

  test("rejects selectors with stable structural reasons", async () => {
    const root = await createScenarioProject();

    await expect(
      loadReducerNativeScenarios({ projectRoot: root }),
    ).rejects.toMatchObject({ code: "NO_SCENARIOS_FOUND" });

    const cases = [
      {
        scenarioPath: "test/scenarios/missing.scenario.ts",
        selectorReason: "notFound",
      },
      {
        scenarioPath: "../outside.scenario.ts",
        selectorReason: "outsideRoot",
      },
      {
        scenarioPath: path.join(
          root,
          "test",
          "scenarios",
          "absolute.scenario.ts",
        ),
        selectorReason: "outsideRoot",
      },
      {
        scenarioPath: "test/scenarios/../outside.scenario.ts",
        selectorReason: "outsideRoot",
      },
      {
        scenarioPath: "nested/shorthand.scenario.ts",
        selectorReason: "outsideRoot",
      },
      {
        scenarioPath: "test/scenarios/not-a-scenario.ts",
        selectorReason: "invalidExtension",
      },
    ] as const;
    for (const selector of cases) {
      await expect(
        discoverReducerNativeScenarioPaths({
          projectRoot: root,
          scenarioPath: selector.scenarioPath,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_SCENARIO_SELECTOR",
        scenarioPath: selector.scenarioPath.replaceAll("\\", "/"),
        selectorReason: selector.selectorReason,
      });
    }
  });

  test("loads only a scenario file's single default definition", async () => {
    const root = await createScenarioProject();
    const scenarioPath = path.join(
      root,
      "test",
      "scenarios",
      "no-default.scenario.ts",
    );
    await writeFile(
      scenarioPath,
      [
        'import { defineScenario } from "../testing-types";',
        'export const scenario = defineScenario({ id: "named-only", setup: { players: 2, seed: 0 }, given: [], when: [], then: async () => {} });',
        "",
      ].join("\n"),
    );

    await expect(
      loadReducerNativeScenarios({
        projectRoot: root,
        scenarioPath: "test/scenarios/no-default.scenario.ts",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_SCENARIO_EXPORT",
      scenarioPath: "test/scenarios/no-default.scenario.ts",
    });
  });

  test("rejects a canonical-looking selector that resolves outside the scenario tree", async () => {
    const root = await createScenarioProject();
    await writeFile(
      path.join(root, "app", "outside.scenario.ts"),
      "export default {};\n",
    );
    await symlink(
      path.join("..", "..", "app", "outside.scenario.ts"),
      path.join(root, "test", "scenarios", "linked.scenario.ts"),
    );

    await expect(
      discoverReducerNativeScenarioPaths({
        projectRoot: root,
        scenarioPath: "test/scenarios/linked.scenario.ts",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_SCENARIO_SELECTOR",
      scenarioPath: "test/scenarios/linked.scenario.ts",
      selectorReason: "outsideRoot",
    });
  });

  test("preserves SDK validation code and path from module evaluation", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "load-invalid.scenario.ts", {
      id: "load-invalid",
      interactionId: "load-invalid",
    });

    await expect(
      loadReducerNativeScenarios({ projectRoot: root }),
    ).rejects.toMatchObject({
      code: "SCENARIO_LOAD_FAILED",
      scenarioPath: "test/scenarios/load-invalid.scenario.ts",
      sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      sdkVersion: "9.8.7-fixture",
      causeName: "ScenarioDefinitionValidationError",
      causeCode: "UNKNOWN_INTERACTION",
      validationPath: "scenario.when[0].interactionId",
    });
  });
});

describe("scenario inspection service", () => {
  test("runs inspect and explore through the selected source-closure bundle", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "observe.scenario.ts", { id: "observe" });
    const common = {
      projectRoot: root,
      scenarioPath: "test/scenarios/observe.scenario.ts",
      perspective: { kind: "player" as const, seat: 0 },
      checkpoint: { segment: "given" as const, count: 0 },
    };

    await expect(inspectReducerNativeScenario(common)).resolves.toMatchObject({
      schemaVersion: 1,
      node: {
        checkpoint: { segment: "given", completed: 0 },
        perspective: { kind: "player", seat: 0 },
      },
    });
    await expect(
      exploreReducerNativeScenario({
        ...common,
        limit: 50,
        maxEvaluations: 5_000,
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      mode: "transitions",
      candidates: [],
      page: { limit: 50, nextCursor: null },
    });
  });

  test("rejects checkpoint bounds before SDK replay", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "bounds.scenario.ts", { id: "bounds" });

    await expect(
      inspectReducerNativeScenario({
        projectRoot: root,
        scenarioPath: "test/scenarios/bounds.scenario.ts",
        perspective: { kind: "player", seat: 0 },
        checkpoint: { segment: "given", count: 1 },
      }),
    ).rejects.toMatchObject({
      name: "TestFamilyCommandError",
      problem: {
        code: "TEST_CHECKPOINT_INVALID",
        context: { maximumCompleted: 0 },
      },
    });
  });
});

describe("scenario test runner", () => {
  test("reports structured replay rejection fields", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "rejected.scenario.ts", {
      id: "rejected",
      interactionId: "reject",
    });

    const summary = await runReducerNativeScenarios({ projectRoot: root });

    expect(summary).toMatchObject({
      passed: 0,
      failed: 1,
      results: [
        {
          id: "rejected",
          scenarioPath: "test/scenarios/rejected.scenario.ts",
          success: false,
          errorCode: "NOT_YOUR_TURN",
          segment: "when",
          index: 0,
          interactionId: "reject",
          reducerMessage: "wrong actor",
          trace: [{ kind: "authorization" }],
        },
      ],
    });
  });

  test("reports scenario validation codes and field paths", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "invalid.scenario.ts", {
      id: "invalid",
      interactionId: "invalid",
    });

    const summary = await runReducerNativeScenarios({ projectRoot: root });

    expect(summary.results[0]).toMatchObject({
      success: false,
      errorCode: "UNKNOWN_INTERACTION",
      validationPath: "scenario.when[0].interactionId",
    });
  });

  test("does not classify arbitrary assertion exceptions as scenario failures", async () => {
    const root = await createScenarioProject();
    await writeScenario(root, "assertion.scenario.ts", {
      id: "assertion",
      assertionError: "expected a visible card",
    });

    await expect(
      runReducerNativeScenarios({ projectRoot: root }),
    ).rejects.toThrow("expected a visible card");
  });
});

async function createScenarioProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dreamboard-scenarios-"));
  roots.push(root);
  await mkdir(path.join(root, "app"), { recursive: true });
  await mkdir(path.join(root, "test", "scenarios"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "@dreamboard-games", "sdk"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "scenario-fixture", type: "module" }),
  );
  await writeFile(
    path.join(root, "node_modules", "@dreamboard-games", "sdk", "package.json"),
    JSON.stringify({
      name: "@dreamboard-games/sdk",
      version: "9.8.7-fixture",
      type: "module",
      exports: {
        "./testing": "./testing.js",
        "./testing-runtime": "./testing-runtime.js",
        "./package.json": "./package.json",
      },
    }),
  );
  await writeFile(
    path.join(root, "node_modules", "@dreamboard-games", "sdk", "testing.js"),
    fakeSdkTestingSource,
  );
  await writeFile(
    path.join(
      root,
      "node_modules",
      "@dreamboard-games",
      "sdk",
      "testing-runtime.js",
    ),
    fakeSdkTestingRuntimeSource,
  );
  await writeFile(
    path.join(root, "app", "game.ts"),
    [
      'import { createFixtureGame } from "@dreamboard-games/sdk/testing";',
      "export default createFixtureGame();",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "test", "testing-types.ts"),
    [
      'import game from "../app/game";',
      'import { createScenarioAuthoring } from "@dreamboard-games/sdk/testing";',
      "export const { defineScenario } = createScenarioAuthoring(game);",
      "",
    ].join("\n"),
  );
  return root;
}

async function writeScenario(
  root: string,
  relativePath: string,
  options: {
    readonly id: string;
    readonly interactionId?: string;
    readonly assertionError?: string;
    readonly helperImport?: boolean;
  },
): Promise<void> {
  const scenarioPath = path.join(root, "test", "scenarios", relativePath);
  await mkdir(path.dirname(scenarioPath), { recursive: true });
  const testingTypesPath = path
    .relative(
      path.dirname(scenarioPath),
      path.join(root, "test", "testing-types"),
    )
    .split(path.sep)
    .join("/");
  const helperPath = path
    .relative(
      path.dirname(scenarioPath),
      path.join(root, "test", "assertion-helper"),
    )
    .split(path.sep)
    .join("/");
  await writeFile(
    scenarioPath,
    [
      `import { defineScenario } from ${JSON.stringify(importSpecifier(testingTypesPath))};`,
      ...(options.helperImport
        ? [
            `import { expected } from ${JSON.stringify(importSpecifier(helperPath))};`,
          ]
        : []),
      "export default defineScenario({",
      `  id: ${JSON.stringify(options.id)},`,
      "  setup: { players: 2, seed: 0 },",
      "  given: [],",
      "  when: [{",
      "    actor: { seat: 0 },",
      `    interactionId: ${JSON.stringify(options.interactionId ?? "pass")},`,
      "    params: {},",
      "  }],",
      "  then: async () => {",
      ...(options.helperImport ? ["    void expected;"] : []),
      ...(options.assertionError
        ? [`    throw new Error(${JSON.stringify(options.assertionError)});`]
        : []),
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

function importSpecifier(value: string): string {
  return value.startsWith(".") ? value : `./${value}`;
}

function relative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

const fakeSdkTestingSource = `
const fixtureGames = new WeakSet();
const sdkMarker = Symbol("fixture-sdk-instance");

export class ScenarioReplayError extends Error {
  constructor(options) {
    super("fixture replay rejected");
    this.name = "ScenarioReplayError";
    Object.assign(this, options);
  }
}

export class ScenarioDefinitionValidationError extends Error {
  constructor(options) {
    super("fixture scenario invalid");
    this.name = "ScenarioDefinitionValidationError";
    Object.assign(this, options);
  }
}

export function createFixtureGame() {
  const game = {};
  fixtureGames.add(game);
  return game;
}

export function createScenarioAuthoring(game) {
  if (!fixtureGames.has(game)) throw new Error("SECOND_SDK_COPY_DURING_AUTHORING");
  return {
    defineScenario: (scenario) => {
      if (scenario.when[0]?.interactionId === "load-invalid") {
        throw new ScenarioDefinitionValidationError({
          code: "UNKNOWN_INTERACTION",
          path: "scenario.when[0].interactionId",
        });
      }
      return scenario;
    },
  };
}

export function toScenarioReplayDefinition(scenario) {
  return {
    id: scenario.id,
    setup: scenario.setup,
    given: scenario.given,
    when: scenario.when,
    __sdkMarker: sdkMarker,
  };
}

export async function replayScenario({ game, scenario }) {
  if (!fixtureGames.has(game) || scenario.__sdkMarker !== sdkMarker) {
    throw new Error("SECOND_SDK_COPY_DURING_REPLAY");
  }
  const command = scenario.when[0];
  if (command?.interactionId === "invalid") {
    throw new ScenarioDefinitionValidationError({
      code: "UNKNOWN_INTERACTION",
      path: "scenario.when[0].interactionId",
    });
  }
  if (command?.interactionId === "reject") {
    throw new ScenarioReplayError({
      scenarioId: scenario.id,
      segment: "when",
      index: 0,
      interactionId: "reject",
      errorCode: "NOT_YOUR_TURN",
      reducerMessage: "wrong actor",
      trace: [{ kind: "authorization" }],
    });
  }
  return { scenarioId: scenario.id, complete: true };
}

export async function assertScenario({ replay, assertion }) {
  if (!replay.complete) throw new Error("partial replay");
  await assertion({});
}

export async function inspectScenario({ scenario, perspective, at }) {
  return {
    schemaVersion: 1,
    node: {
      checkpoint: at,
      checkpointDigest: "sha256:fixture",
      flow: { phase: "main" },
      perspective,
      view: null,
      interactions: [],
    },
  };
}

export async function exploreScenario({ scenario, perspective, at }) {
  return {
    schemaVersion: 1,
    mode: "transitions",
    scenario: { id: scenario.id },
    perspective,
    node: {
      checkpoint: at,
      checkpointDigest: "sha256:fixture",
    },
    candidates: [],
    omissions: [],
    page: { limit: 50, evaluated: 0, truncated: false, nextCursor: null },
  };
}

`;

const fakeSdkTestingRuntimeSource = `
export function resolveScenarioCommandParams({ params }) {
  return params;
}

export function scenarioProjectionInputMetadata(input) {
  return { key: input.key, kind: input.kind, eligibleCount: 0 };
}

export function scenarioProjectionParityFromInspectNode(node) {
  return {
    perspective: { seat: node.perspective.seat },
    flow: {
      phase: node.flow.phase,
      step: null,
      activeSeats: [],
      pendingSeats: [],
      continuationWaiterSeats: [],
      blockedBy: [],
    },
    view: node.view,
    interactions: [],
  };
}

export function digestScenarioProjection(projection) {
  return JSON.stringify(projection);
}
`;
