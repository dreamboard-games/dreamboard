import { describe, expect, test } from "bun:test";
import type { HostSessionSnapshot } from "@dreamboard-games/api-client";
import {
  createSessionFromScenario,
  parseScenarioCheckpoint,
  ScenarioDevMaterializationError,
} from "./scenario-dev-materializer.js";
import type {
  LoadedReducerNativeScenario,
  ScenarioCheckpointLike,
  ScenarioProjectionParityLike,
} from "./scenario-loader.js";

describe("scenario dev checkpoint parsing", () => {
  const definition = {
    given: [{}, {}],
    when: [{}],
  } as Pick<LoadedReducerNativeScenario["definition"], "given" | "when">;

  test("defaults to the end of given and accepts the exact checkpoint grammar", () => {
    expect(parseScenarioCheckpoint(undefined, definition)).toEqual({
      segment: "given",
      completed: 2,
    });
    expect(parseScenarioCheckpoint("setup", definition)).toEqual({
      segment: "setup",
      completed: 0,
    });
    expect(parseScenarioCheckpoint("given:0", definition)).toEqual({
      segment: "given",
      completed: 0,
    });
    expect(parseScenarioCheckpoint("when:1", definition)).toEqual({
      segment: "when",
      completed: 1,
    });
  });

  test("rejects malformed and out-of-range checkpoints", () => {
    for (const value of ["given", "setup:0", "given:-1", "given:03"]) {
      expect(() => parseScenarioCheckpoint(value, definition)).toThrow(
        ScenarioDevMaterializationError,
      );
    }
    expect(() => parseScenarioCheckpoint("when:2", definition)).toThrow(
      "when accepts 0 through 1",
    );
  });
});

describe("scenario dev backend replay", () => {
  test("creates a normal session and replays the selected accepted prefix", async () => {
    const harness = createBackendHarness();
    const result = await createSessionFromScenario(
      {
        projectRoot: "/workspace",
        scenarioPath: "test/scenarios/opening.scenario.ts",
        at: "when:1",
        compiledResultId: "compile-1",
        projectId: "project-1",
      },
      harness.dependencies,
    );

    expect(harness.createRequests).toEqual([
      {
        projectId: "project-1",
        request: {
          compiledResultId: "compile-1",
          seed: 17,
          playerCount: 1,
          autoAssignSeats: true,
          setupProfileId: "standard",
        },
      },
    ]);
    expect(harness.submissions.map((entry) => entry.body)).toEqual([
      {
        expectedVersion: 0,
        actionSetVersion: "actions:0",
        inputs: { amount: 1 },
      },
      {
        expectedVersion: 1,
        actionSetVersion: "actions:1",
        inputs: { amount: 1 },
      },
      {
        expectedVersion: 2,
        actionSetVersion: "actions:2",
        inputs: { amount: 1 },
      },
    ]);
    expect(result).toMatchObject({
      sessionId: "session-1",
      projectId: "project-1",
      seed: 17,
      playerCount: 1,
      setupProfileId: "standard",
      scenarioId: "opening",
      materialization: {
        mode: "replay",
        commandsReplayed: 3,
        checkpoint: { segment: "when", completed: 1 },
        scenarioSourceDigest:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        localCheckpointDigest: "sha256:checkpoint-3",
        publicProjectionDigest: expect.any(String),
        projections: [{ seat: 0 }],
      },
    });
    expect(result.materialization.projections[0]?.localDigest).toMatch(
      /^sha256:/,
    );
    expect(result.materialization.projections[0]?.localDigest).toBe(
      result.materialization.projections[0]?.backendDigest,
    );
  });

  test("the default checkpoint replays given but leaves when for the author", async () => {
    const harness = createBackendHarness();
    const result = await createSessionFromScenario(
      {
        projectRoot: "/workspace",
        scenarioPath: "test/scenarios/opening.scenario.ts",
        compiledResultId: "compile-1",
        projectId: "project-1",
      },
      harness.dependencies,
    );

    expect(harness.submissions).toHaveLength(2);
    expect(result.materialization).toMatchObject({
      commandsReplayed: 2,
      checkpoint: { segment: "given", completed: 2 },
    });
  });

  test("replays a nonzero actor seat and proves every player projection", async () => {
    const harness = createBackendHarness({ playerCount: 2, actorSeat: 1 });
    const result = await createSessionFromScenario(
      {
        projectRoot: "/workspace",
        scenarioPath: "test/scenarios/opening.scenario.ts",
        at: "given:1",
        compiledResultId: "compile-1",
        projectId: "project-1",
      },
      harness.dependencies,
    );

    expect(harness.submissions).toHaveLength(1);
    expect(harness.submissions[0]?.path).toMatchObject({
      playerId: "player-2",
      interactionId: "increment",
    });
    expect(result.materialization.projections.map(({ seat }) => seat)).toEqual([
      0, 1,
    ]);
  });

  test("reports the exact source command when backend dispatch rejects", async () => {
    const harness = createBackendHarness({ rejectAtVersion: 1 });

    try {
      await createSessionFromScenario(
        {
          projectRoot: "/workspace",
          scenarioPath: "test/scenarios/opening.scenario.ts",
          at: "given:2",
          compiledResultId: "compile-1",
          projectId: "project-1",
        },
        harness.dependencies,
      );
      throw new Error("expected backend rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioDevMaterializationError);
      expect(error).toMatchObject({
        code: "SCENARIO_BACKEND_REPLAY_REJECTED",
        scenarioPath: "test/scenarios/opening.scenario.ts",
        sourceCommand: {
          segment: "given",
          index: 1,
          interactionId: "increment",
        },
        backendErrorCode: "BACKEND_RULE_CHANGED",
      });
      expect((error as Error).message).toContain("scenario.given[1]");
    }
  });

  test("reports the first source command whose projection diverges", async () => {
    const harness = createBackendHarness({ divergentAtVersion: 1 });

    try {
      await createSessionFromScenario(
        {
          projectRoot: "/workspace",
          scenarioPath: "test/scenarios/opening.scenario.ts",
          at: "given:2",
          compiledResultId: "compile-1",
          projectId: "project-1",
        },
        harness.dependencies,
      );
      throw new Error("expected backend divergence");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioDevMaterializationError);
      expect(error).toMatchObject({
        code: "SCENARIO_BACKEND_REPLAY_DIVERGED",
        checkpoint: { segment: "given", completed: 1 },
        sourceCommand: {
          segment: "given",
          index: 0,
          interactionId: "increment",
        },
        perspectiveSeat: 0,
      });
      expect((error as Error).message).toContain("scenario.given[0]");
    }
  });

  test("does not silently accept a backend-selected setup profile", async () => {
    const harness = createBackendHarness({ backendSetupProfileId: "other" });

    await expect(
      createSessionFromScenario(
        {
          projectRoot: "/workspace",
          scenarioPath: "test/scenarios/opening.scenario.ts",
          at: "setup",
          compiledResultId: "compile-1",
          projectId: "project-1",
        },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({
      code: "SCENARIO_BACKEND_REPLAY_DIVERGED",
      checkpoint: { segment: "setup", completed: 0 },
    });
  });

  test("rejects a compiled replay that diverges from the loaded scenario", async () => {
    const harness = createBackendHarness();
    const compileScenario = harness.dependencies.compileScenario;

    await expect(
      createSessionFromScenario(
        {
          projectRoot: "/workspace",
          scenarioPath: "test/scenarios/opening.scenario.ts",
          at: "setup",
          compiledResultId: "compile-1",
          projectId: "project-1",
        },
        {
          ...harness.dependencies,
          compileScenario: async (options) => {
            const compiled = await compileScenario(options);
            return {
              ...compiled,
              definition: { ...compiled.definition, id: "different" },
            };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "SCENARIO_COMPILED_REPLAY_INVALID",
      checkpoint: { segment: "setup", completed: 0 },
    });
    expect(harness.createRequests).toHaveLength(0);
  });
});

function createBackendHarness(
  options: {
    readonly rejectAtVersion?: number;
    readonly divergentAtVersion?: number;
    readonly backendSetupProfileId?: string;
    readonly playerCount?: number;
    readonly actorSeat?: number;
  } = {},
) {
  const playerCount = options.playerCount ?? 1;
  const actorSeat = options.actorSeat ?? 0;
  const scenario = createLoadedScenario({ playerCount, actorSeat });
  let version = 0;
  const createRequests: unknown[] = [];
  const submissions: Array<{
    readonly path: unknown;
    readonly body: unknown;
  }> = [];

  const snapshot = (perspectivePlayerId = "player-1") =>
    createGameplaySnapshot({
      version,
      perspectivePlayerId,
      viewValue:
        options.divergentAtVersion === version ? version + 100 : version,
      setupProfileId: options.backendSetupProfileId ?? "standard",
      playerCount,
      activeSeat: actorSeat,
    });

  return {
    createRequests,
    submissions,
    dependencies: {
      loadScenarios: async () => [scenario],
      compileScenario: async ({ at }) => {
        const checkpoint = at ?? {
          segment: "given" as const,
          completed: scenario.definition.given.length,
        };
        const inspected = await scenario.inspectScenario({
          game: scenario.game,
          scenario: scenario.replayDefinition,
          identity: {
            id: scenario.id,
            path: scenario.scenarioPath,
            sourceDigest: scenario.sourceDigest,
          },
          perspective: { kind: "spectator" },
          at: checkpoint,
        });
        const publicProjection =
          scenario.scenarioProjectionParityFromInspectNode(inspected.node);
        return {
          schemaVersion: 1 as const,
          scenario: {
            path: scenario.scenarioPath,
            sourceDigest: scenario.sourceDigest as `sha256:${string}`,
          },
          definition: scenario.replayDefinition,
          checkpoint,
          expected: {
            checkpointDigest: inspected.node
              .checkpointDigest as `sha256:${string}`,
            publicProjectionDigest: scenario.digestScenarioProjection(
              publicProjection,
            ) as `sha256:${string}`,
          },
        };
      },
      createSession: async (request: unknown) => {
        createRequests.push(request);
        return {
          sessionId: "session-1",
          shortCode: "calm-cloud-17",
          hostActor: { kind: "AUTH_USER", id: "user-1" },
          gameSource: {
            kind: "USER_COMPILED",
            projectId: "project-1",
            revisionDigest: "sha256:revision",
            compiledResultId: "compile-1",
          },
        } as never;
      },
      startSession: async () => snapshot(),
      readSession: async ({ playerId }: { playerId: string }) =>
        snapshot(playerId),
      submitAction: async (request: {
        readonly path: unknown;
        readonly body: {
          readonly expectedVersion: number;
          readonly actionSetVersion: string;
          readonly inputs: Record<string, unknown>;
        };
      }) => {
        submissions.push(request);
        if (options.rejectAtVersion === version) {
          return {
            data: {
              success: false,
              accepted: false,
              version,
              actionSetVersion: `actions:${version}`,
              errorCode: "BACKEND_RULE_CHANGED",
            },
          };
        }
        version += 1;
        return {
          data: {
            success: true,
            accepted: true,
            version,
            actionSetVersion: `actions:${version}`,
          },
        };
      },
    },
  };
}

function createLoadedScenario(
  options: {
    readonly playerCount: number;
    readonly actorSeat: number;
  } = { playerCount: 1, actorSeat: 0 },
): LoadedReducerNativeScenario {
  const commands = [
    {
      actor: { seat: options.actorSeat },
      interactionId: "increment",
      params: { amount: 1 },
    },
    {
      actor: { seat: options.actorSeat },
      interactionId: "increment",
      params: { amount: 1 },
    },
  ] as const;
  const definition = {
    id: "opening",
    setup: {
      players: options.playerCount,
      seed: 17,
      setupProfileId: "standard",
    },
    given: commands,
    when: [
      {
        actor: { seat: options.actorSeat },
        interactionId: "increment",
        params: { amount: 1 },
      },
    ],
    then: () => undefined,
  } as const;

  return {
    id: definition.id,
    scenarioPath: "test/scenarios/opening.scenario.ts",
    sourceDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    sourceInputs: [],
    sdkVersion: "9.8.7-fixture",
    game: {},
    definition,
    replayDefinition: definition,
    replayScenario: async () => ({}),
    assertScenario: async () => undefined,
    inspectScenario: async ({ at, perspective }) => {
      const value = completedCommands(at, definition.given.length);
      return {
        schemaVersion: 1,
        node: {
          checkpoint: at,
          checkpointDigest: `sha256:checkpoint-${value}`,
          flow: { phase: "main" },
          __value: value,
          __seat:
            perspective.kind === "player" ? perspective.seat : "spectator",
        },
      } as never;
    },
    resolveScenarioCommandParams: ({ params }) =>
      params as Record<string, unknown>,
    scenarioProjectionInputMetadata: (input) => ({
      key: input.key,
      kind: input.kind,
      eligibleCount: 0,
    }),
    scenarioProjectionParityFromInspectNode: (node) => {
      const fixtureNode = node as typeof node & {
        readonly __value: number;
        readonly __seat: number | "spectator";
      };
      return expectedProjection(
        fixtureNode.__value,
        fixtureNode.__seat,
        options.actorSeat,
      );
    },
    digestScenarioProjection: (projection) =>
      `sha256:${JSON.stringify(projection)}`,
    ScenarioReplayError: class extends Error {},
    ScenarioDefinitionValidationError: class extends Error {},
  };
}

function completedCommands(
  checkpoint: ScenarioCheckpointLike,
  givenLength: number,
): number {
  if (checkpoint.segment === "setup") return 0;
  if (checkpoint.segment === "given") return checkpoint.completed;
  return givenLength + checkpoint.completed;
}

function expectedProjection(
  value: number,
  seat: number | "spectator",
  activeSeat = 0,
): ScenarioProjectionParityLike {
  return {
    perspective: seat === "spectator" ? "spectator" : { seat },
    flow: {
      phase: "main",
      step: null,
      activeSeats: [activeSeat],
      pendingSeats: [],
      continuationWaiterSeats: [],
      blockedBy: [],
    },
    view: { value },
    interactions: [
      {
        actorSeat: seat === "spectator" ? activeSeat : seat,
        interactionId: "increment",
        availability: { status: "available" },
        inputs: [],
      },
    ],
  };
}

function createGameplaySnapshot(options: {
  readonly version: number;
  readonly perspectivePlayerId: string;
  readonly viewValue: number;
  readonly setupProfileId: string;
  readonly playerCount: number;
  readonly activeSeat: number;
}): HostSessionSnapshot {
  const playerIds = Array.from(
    { length: options.playerCount },
    (_, index) => `player-${index + 1}`,
  );
  return {
    type: "gameplay",
    context: {
      sessionId: "session-1",
      shortCode: "calm-cloud-17",
      phase: "gameplay",
      status: "active",
      hostActor: { kind: "AUTH_USER", id: "user-1" },
      gameSource: {
        kind: "USER_COMPILED",
        projectId: "project-1",
        revisionDigest: "sha256:revision",
        compiledResultId: "compile-1",
      },
      setupProfileId: options.setupProfileId,
      switchablePlayerIds: playerIds,
    },
    lobby: {
      seats: playerIds.map((playerId, index) => ({
        playerId,
        displayName: `Player ${index + 1}`,
        isHost: index === 0,
      })),
      canStart: false,
      hostActor: { kind: "AUTH_USER", id: "user-1" },
      setupProfileId: options.setupProfileId,
    },
    gameplay: {
      version: options.version,
      actionSetVersion: `actions:${options.version}`,
      perspectivePlayerId: options.perspectivePlayerId,
      controllablePlayerIds: playerIds,
      shared: {
        activePlayers: [playerIds[options.activeSeat]!],
        currentPhase: "main",
        currentStage: null,
        stageSeats: [],
      },
      interactionsByRef: {
        increment: {
          kind: "action",
          phaseName: "main",
          interactionKey: "increment",
          interactionId: "increment",
          commit: { mode: "manual" },
          inputs: [],
          availability: { status: "available" },
        },
      },
      seats: Object.fromEntries(
        playerIds.map((playerId) => [
          playerId,
          {
            actionSetVersion: `actions:${options.version}`,
            view: JSON.stringify({ value: options.viewValue }),
            availableInteractionRefs: ["increment"],
            zones: {},
          },
        ]),
      ),
    },
  };
}
