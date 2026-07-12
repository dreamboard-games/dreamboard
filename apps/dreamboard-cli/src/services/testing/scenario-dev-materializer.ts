import {
  getSessionSnapshot,
  startGame,
  type HostSessionSnapshot,
} from "@dreamboard-games/api-client";
import { createProjectSessionSdk } from "../api/index.js";
import { submitGameplayAuthorityAction } from "../gameplay-authority-submit.js";
import { toDreamboardApiError } from "../../utils/errors.js";
import { projectIdFromSessionGameSource } from "../../utils/session-game-source.js";
import {
  compileReducerNativeScenarioReplay,
  loadReducerNativeScenarios,
  type CompiledScenarioReplayLike,
  type LoadedReducerNativeScenario,
  type ScenarioCheckpointLike,
  type ScenarioCommandLike,
  type ScenarioProjectionParityLike,
} from "./scenario-loader.js";

export type ScenarioDevMaterializationErrorCode =
  | "SCENARIO_CHECKPOINT_INVALID"
  | "SCENARIO_COMPILED_REPLAY_INVALID"
  | "SCENARIO_BACKEND_START_FAILED"
  | "SCENARIO_BACKEND_SNAPSHOT_UNAVAILABLE"
  | "SCENARIO_BACKEND_REPLAY_REJECTED"
  | "SCENARIO_BACKEND_REPLAY_DIVERGED";

export type ScenarioSourceCommand = {
  readonly segment: "given" | "when";
  readonly index: number;
  readonly interactionId: string;
};

export class ScenarioDevMaterializationError extends Error {
  readonly code: ScenarioDevMaterializationErrorCode;
  readonly scenarioId?: string;
  readonly scenarioPath?: string;
  readonly checkpoint?: ScenarioCheckpointLike;
  readonly sourceCommand?: ScenarioSourceCommand;
  readonly perspectiveSeat?: number;
  readonly localDigest?: string;
  readonly backendDigest?: string;
  readonly backendErrorCode?: string;

  constructor(options: {
    readonly code: ScenarioDevMaterializationErrorCode;
    readonly message: string;
    readonly scenarioId?: string;
    readonly scenarioPath?: string;
    readonly checkpoint?: ScenarioCheckpointLike;
    readonly sourceCommand?: ScenarioSourceCommand;
    readonly perspectiveSeat?: number;
    readonly localDigest?: string;
    readonly backendDigest?: string;
    readonly backendErrorCode?: string;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ScenarioDevMaterializationError";
    this.code = options.code;
    this.scenarioId = options.scenarioId;
    this.scenarioPath = options.scenarioPath;
    this.checkpoint = options.checkpoint;
    this.sourceCommand = options.sourceCommand;
    this.perspectiveSeat = options.perspectiveSeat;
    this.localDigest = options.localDigest;
    this.backendDigest = options.backendDigest;
    this.backendErrorCode = options.backendErrorCode;
  }
}

export type ScenarioProjectionDigestProof = {
  readonly seat: number;
  readonly localDigest: string;
  readonly backendDigest: string;
};

export type ScenarioReplayMaterialization = {
  readonly mode: "replay";
  readonly totalMs: number;
  readonly commandsReplayed: number;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly scenarioSourceDigest: string;
  readonly localCheckpointDigest: string;
  readonly publicProjectionDigest: string;
  readonly projections: readonly ScenarioProjectionDigestProof[];
};

export type ScenarioDevSession = {
  readonly sessionId: string;
  readonly shortCode: string;
  readonly projectId: string;
  readonly seed: number;
  readonly playerCount: number;
  readonly setupProfileId: string | null;
  readonly scenarioId: string;
  readonly scenarioPath: string;
  readonly materialization: ScenarioReplayMaterialization;
};

type ScenarioMaterializerDependencies = {
  readonly loadScenarios: typeof loadReducerNativeScenarios;
  readonly compileScenario: typeof compileReducerNativeScenarioReplay;
  readonly createSession: typeof createProjectSessionSdk;
  readonly startSession: (sessionId: string) => Promise<HostSessionSnapshot>;
  readonly readSession: (options: {
    readonly sessionId: string;
    readonly playerId: string;
  }) => Promise<HostSessionSnapshot>;
  readonly submitAction: typeof submitGameplayAuthorityAction;
};

const defaultDependencies: ScenarioMaterializerDependencies = {
  loadScenarios: loadReducerNativeScenarios,
  compileScenario: compileReducerNativeScenarioReplay,
  createSession: createProjectSessionSdk,
  startSession: startBackendSession,
  readSession: readBackendSession,
  submitAction: submitGameplayAuthorityAction,
};

export function parseScenarioCheckpoint(
  value: string | undefined,
  scenario: Pick<LoadedReducerNativeScenario["definition"], "given" | "when">,
): ScenarioCheckpointLike {
  const selector = value?.trim();
  if (!selector) {
    return { segment: "given", completed: scenario.given.length };
  }
  if (selector === "setup") {
    return { segment: "setup", completed: 0 };
  }
  const match = /^(given|when):(0|[1-9]\d*)$/u.exec(selector);
  if (!match) {
    throw checkpointError(
      `Invalid scenario checkpoint '${selector}'. Expected setup, given:<n>, or when:<n>.`,
    );
  }
  const segment = match[1] as "given" | "when";
  const completed = Number(match[2]);
  const maximum = scenario[segment].length;
  if (!Number.isSafeInteger(completed) || completed > maximum) {
    throw checkpointError(
      `Invalid scenario checkpoint '${selector}'. ${segment} accepts 0 through ${maximum} completed command(s).`,
      { segment, completed },
    );
  }
  return { segment, completed };
}

export async function createSessionFromScenario(
  options: {
    readonly projectRoot: string;
    readonly scenarioPath: string;
    readonly at?: string;
    readonly compiledResultId: string;
    readonly projectId: string;
  },
  dependencies: Partial<ScenarioMaterializerDependencies> = {},
): Promise<ScenarioDevSession> {
  const startedAt = performance.now();
  const deps = { ...defaultDependencies, ...dependencies };
  const [scenario] = await deps.loadScenarios({
    projectRoot: options.projectRoot,
    scenarioPath: options.scenarioPath,
  });
  if (!scenario) {
    throw new Error(
      `Scenario loader returned no scenario for '${options.scenarioPath}'.`,
    );
  }
  const checkpoint = parseScenarioCheckpoint(options.at, scenario.definition);
  const compiledReplay = await deps.compileScenario({
    projectRoot: options.projectRoot,
    scenarioPath: scenario.scenarioPath,
    at: checkpoint,
  });
  const authorityScenario = requireMatchingCompiledReplay({
    scenario,
    compiledReplay,
    checkpoint,
  });

  // Validate normal setup and every selected source command before creating a
  // disposable backend session. This replay is the local authority used for
  // the final checkpoint receipt; it never serializes reducer state.
  const targetInspection = await inspectLocalScenario({
    scenario: authorityScenario,
    checkpoint,
    perspective: { kind: "player", seat: 0 },
  });
  if (
    targetInspection.node.checkpointDigest !==
    compiledReplay.expected.checkpointDigest
  ) {
    throw compiledReplayError({
      scenario,
      checkpoint,
      message:
        `Compiled checkpoint digest ${compiledReplay.expected.checkpointDigest} ` +
        `does not match local replay ${targetInspection.node.checkpointDigest}.`,
    });
  }
  const publicInspection = await inspectLocalScenario({
    scenario: authorityScenario,
    checkpoint,
    perspective: { kind: "spectator" },
  });
  const publicProjectionDigest = authorityScenario.digestScenarioProjection(
    authorityScenario.scenarioProjectionParityFromInspectNode(
      publicInspection.node,
    ),
  );
  if (
    publicProjectionDigest !== compiledReplay.expected.publicProjectionDigest
  ) {
    throw compiledReplayError({
      scenario,
      checkpoint,
      message:
        `Compiled public projection digest ${compiledReplay.expected.publicProjectionDigest} ` +
        `does not match local replay ${publicProjectionDigest}.`,
    });
  }
  const session = await deps.createSession({
    projectId: options.projectId,
    request: {
      compiledResultId: options.compiledResultId,
      seed: compiledReplay.definition.setup.seed,
      playerCount: compiledReplay.definition.setup.players,
      autoAssignSeats: true,
      ...(typeof compiledReplay.definition.setup.setupProfileId === "string"
        ? { setupProfileId: compiledReplay.definition.setup.setupProfileId }
        : {}),
    },
  });
  const startedSnapshot = await deps.startSession(session.sessionId);
  const expectedSetupProfileId =
    compiledReplay.definition.setup.setupProfileId ?? null;
  const backendSetupProfileId = startedSnapshot.context.setupProfileId ?? null;
  if (backendSetupProfileId !== expectedSetupProfileId) {
    throw new ScenarioDevMaterializationError({
      code: "SCENARIO_BACKEND_REPLAY_DIVERGED",
      message:
        `Scenario setup profile '${expectedSetupProfileId ?? "none"}' diverged from ` +
        `backend profile '${backendSetupProfileId ?? "none"}'.`,
      scenarioId: scenario.id,
      scenarioPath: scenario.scenarioPath,
      checkpoint: { segment: "setup", completed: 0 },
    });
  }
  const backendPlayerIds = requireBackendPlayerIds({
    snapshot: startedSnapshot,
    expectedCount: compiledReplay.definition.setup.players,
    scenario: authorityScenario,
  });
  const localInspectionCache = new Map<
    string,
    Awaited<ReturnType<typeof inspectLocalScenario>>
  >();
  localInspectionCache.set(localInspectionKey(checkpoint, 0), targetInspection);

  let currentCheckpoint: ScenarioCheckpointLike = {
    segment: "setup",
    completed: 0,
  };
  let parity = await assertCheckpointParity({
    scenario: authorityScenario,
    checkpoint: currentCheckpoint,
    sessionId: session.sessionId,
    backendPlayerIds,
    deps,
    localInspectionCache,
    preferredSnapshot: startedSnapshot,
  });
  let commandsReplayed = 0;

  for (const step of selectedScenarioCommands(authorityScenario, checkpoint)) {
    const actorPlayerId = backendPlayerIds[step.command.actor.seat];
    if (!actorPlayerId) {
      throw new ScenarioDevMaterializationError({
        code: "SCENARIO_BACKEND_REPLAY_REJECTED",
        message: `${formatSourceCommand(step.source)} references seat ${step.command.actor.seat}, but the backend created ${backendPlayerIds.length} seat(s).`,
        scenarioId: authorityScenario.id,
        scenarioPath: authorityScenario.scenarioPath,
        checkpoint: currentCheckpoint,
        sourceCommand: step.source,
      });
    }
    const actorSnapshot =
      parity.snapshotsBySeat.get(step.command.actor.seat) ??
      (await deps.readSession({
        sessionId: session.sessionId,
        playerId: actorPlayerId,
      }));
    const gameplay = requireGameplaySnapshot({
      snapshot: actorSnapshot,
      scenario: authorityScenario,
      checkpoint: currentCheckpoint,
      sourceCommand: step.source,
    });
    const actorSeatProjection = gameplay.seats[actorPlayerId];
    if (!actorSeatProjection) {
      throw backendSnapshotError({
        scenario: authorityScenario,
        checkpoint: currentCheckpoint,
        sourceCommand: step.source,
        message: `${formatSourceCommand(step.source)} cannot resolve backend projection for seat ${step.command.actor.seat}.`,
      });
    }
    const beforeInspection = await cachedLocalInspection({
      scenario: authorityScenario,
      checkpoint: currentCheckpoint,
      seat: step.command.actor.seat,
      cache: localInspectionCache,
    });
    const inputs = authorityScenario.resolveScenarioCommandParams({
      game: authorityScenario.game,
      phase: beforeInspection.node.flow.phase,
      interactionId: step.command.interactionId,
      params: step.command.params,
      playerIds: backendPlayerIds,
      path: formatSourceCommand(step.source),
    });
    const submitted = await deps.submitAction({
      path: {
        sessionId: session.sessionId,
        playerId: actorPlayerId,
        interactionId: step.command.interactionId,
      },
      body: {
        expectedVersion: gameplay.version,
        actionSetVersion: actorSeatProjection.actionSetVersion,
        inputs,
      },
    });
    if (submitted.error || submitted.data?.accepted !== true) {
      const backendErrorCode = submitted.data?.errorCode ?? undefined;
      throw new ScenarioDevMaterializationError({
        code: "SCENARIO_BACKEND_REPLAY_REJECTED",
        message:
          `${formatSourceCommand(step.source)} interaction '${step.command.interactionId}' ` +
          `was accepted locally but rejected by the backend` +
          (backendErrorCode ? ` with ${backendErrorCode}.` : "."),
        scenarioId: authorityScenario.id,
        scenarioPath: authorityScenario.scenarioPath,
        checkpoint: currentCheckpoint,
        sourceCommand: step.source,
        backendErrorCode,
        cause: submitted.error,
      });
    }
    currentCheckpoint = step.after;
    commandsReplayed += 1;
    parity = await assertCheckpointParity({
      scenario: authorityScenario,
      checkpoint: currentCheckpoint,
      sessionId: session.sessionId,
      backendPlayerIds,
      deps,
      localInspectionCache,
      sourceCommand: step.source,
    });
  }

  return {
    sessionId: session.sessionId,
    shortCode: session.shortCode,
    projectId: projectIdFromSessionGameSource(session.gameSource),
    seed: compiledReplay.definition.setup.seed,
    playerCount: compiledReplay.definition.setup.players,
    setupProfileId: compiledReplay.definition.setup.setupProfileId ?? null,
    scenarioId: authorityScenario.id,
    scenarioPath: authorityScenario.scenarioPath,
    materialization: {
      mode: "replay",
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      commandsReplayed,
      checkpoint,
      scenarioSourceDigest: compiledReplay.scenario.sourceDigest,
      localCheckpointDigest: targetInspection.node.checkpointDigest,
      publicProjectionDigest,
      projections: parity.proofs,
    },
  };
}

function requireMatchingCompiledReplay(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly compiledReplay: CompiledScenarioReplayLike;
  readonly checkpoint: ScenarioCheckpointLike;
}): LoadedReducerNativeScenario {
  const compiled = options.compiledReplay;
  const mismatches = [
    compiled.scenario.path === options.scenario.scenarioPath
      ? null
      : `path '${compiled.scenario.path}'`,
    compiled.definition.id === options.scenario.id
      ? null
      : `id '${compiled.definition.id}'`,
    JSON.stringify(compiled.checkpoint) === JSON.stringify(options.checkpoint)
      ? null
      : `checkpoint ${JSON.stringify(compiled.checkpoint)}`,
    JSON.stringify(compiled.definition) ===
    JSON.stringify(options.scenario.replayDefinition)
      ? null
      : "serialized definition",
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw compiledReplayError({
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      message: `Compiled replay disagrees with loaded source authority: ${mismatches.join(", ")}.`,
    });
  }
  return {
    ...options.scenario,
    sourceDigest: compiled.scenario.sourceDigest,
    replayDefinition: compiled.definition,
  };
}

function compiledReplayError(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly message: string;
}): ScenarioDevMaterializationError {
  return new ScenarioDevMaterializationError({
    code: "SCENARIO_COMPILED_REPLAY_INVALID",
    message: options.message,
    scenarioId: options.scenario.id,
    scenarioPath: options.scenario.scenarioPath,
    checkpoint: options.checkpoint,
  });
}

type SelectedScenarioCommand = {
  readonly source: ScenarioSourceCommand;
  readonly command: ScenarioCommandLike;
  readonly after: ScenarioCheckpointLike;
};

function selectedScenarioCommands(
  scenario: LoadedReducerNativeScenario,
  target: ScenarioCheckpointLike,
): readonly SelectedScenarioCommand[] {
  const givenCount =
    target.segment === "setup"
      ? 0
      : target.segment === "given"
        ? target.completed
        : scenario.replayDefinition.given.length;
  const whenCount = target.segment === "when" ? target.completed : 0;
  return [
    ...scenario.replayDefinition.given
      .slice(0, givenCount)
      .map((command, index) => ({
        source: {
          segment: "given" as const,
          index,
          interactionId: command.interactionId,
        },
        command,
        after: { segment: "given" as const, completed: index + 1 },
      })),
    ...scenario.replayDefinition.when
      .slice(0, whenCount)
      .map((command, index) => ({
        source: {
          segment: "when" as const,
          index,
          interactionId: command.interactionId,
        },
        command,
        after: { segment: "when" as const, completed: index + 1 },
      })),
  ];
}

async function inspectLocalScenario(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly perspective:
    | { readonly kind: "player"; readonly seat: number }
    | { readonly kind: "spectator" };
}) {
  return options.scenario.inspectScenario({
    game: options.scenario.game,
    scenario: options.scenario.replayDefinition,
    identity: {
      id: options.scenario.id,
      path: options.scenario.scenarioPath,
      sourceDigest: options.scenario.sourceDigest,
    },
    perspective: options.perspective,
    at: options.checkpoint,
  });
}

async function cachedLocalInspection(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly seat: number;
  readonly cache: Map<string, Awaited<ReturnType<typeof inspectLocalScenario>>>;
}) {
  const key = localInspectionKey(options.checkpoint, options.seat);
  const cached = options.cache.get(key);
  if (cached) return cached;
  const inspected = await inspectLocalScenario({
    scenario: options.scenario,
    checkpoint: options.checkpoint,
    perspective: { kind: "player", seat: options.seat },
  });
  options.cache.set(key, inspected);
  return inspected;
}

function localInspectionKey(
  checkpoint: ScenarioCheckpointLike,
  seat: number,
): string {
  return `${checkpoint.segment}:${checkpoint.completed}:player:${seat}`;
}

async function assertCheckpointParity(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly sessionId: string;
  readonly backendPlayerIds: readonly string[];
  readonly deps: ScenarioMaterializerDependencies;
  readonly localInspectionCache: Map<
    string,
    Awaited<ReturnType<typeof inspectLocalScenario>>
  >;
  readonly preferredSnapshot?: HostSessionSnapshot;
  readonly sourceCommand?: ScenarioSourceCommand;
}): Promise<{
  readonly proofs: readonly ScenarioProjectionDigestProof[];
  readonly snapshotsBySeat: ReadonlyMap<number, HostSessionSnapshot>;
}> {
  const proofs: ScenarioProjectionDigestProof[] = [];
  const snapshotsBySeat = new Map<number, HostSessionSnapshot>();
  for (const [seat, playerId] of options.backendPlayerIds.entries()) {
    const snapshot =
      seat === 0 &&
      options.preferredSnapshot?.type === "gameplay" &&
      options.preferredSnapshot.gameplay.perspectivePlayerId === playerId
        ? options.preferredSnapshot
        : await options.deps.readSession({
            sessionId: options.sessionId,
            playerId,
          });
    snapshotsBySeat.set(seat, snapshot);
    const gameplay = requireGameplaySnapshot({
      snapshot,
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      sourceCommand: options.sourceCommand,
    });
    const local = await cachedLocalInspection({
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      seat,
      cache: options.localInspectionCache,
    });
    const localProjection =
      options.scenario.scenarioProjectionParityFromInspectNode(local.node);
    const backendProjection = backendScenarioProjection({
      scenario: options.scenario,
      gameplay,
      playerId,
      playerIds: options.backendPlayerIds,
      seat,
    });
    const localDigest =
      options.scenario.digestScenarioProjection(localProjection);
    const backendDigest =
      options.scenario.digestScenarioProjection(backendProjection);
    if (localDigest !== backendDigest) {
      const location = options.sourceCommand
        ? formatSourceCommand(options.sourceCommand)
        : "scenario setup";
      throw new ScenarioDevMaterializationError({
        code: "SCENARIO_BACKEND_REPLAY_DIVERGED",
        message:
          `${location} diverged between local replay and backend projection ` +
          `for player:${seat} (local ${localDigest}, backend ${backendDigest}).`,
        scenarioId: options.scenario.id,
        scenarioPath: options.scenario.scenarioPath,
        checkpoint: options.checkpoint,
        sourceCommand: options.sourceCommand,
        perspectiveSeat: seat,
        localDigest,
        backendDigest,
      });
    }
    proofs.push({ seat, localDigest, backendDigest });
  }
  return { proofs, snapshotsBySeat };
}

function backendScenarioProjection(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly gameplay: Extract<
    HostSessionSnapshot,
    { type: "gameplay" }
  >["gameplay"];
  readonly playerId: string;
  readonly playerIds: readonly string[];
  readonly seat: number;
}): ScenarioProjectionParityLike {
  const seatProjection = options.gameplay.seats[options.playerId];
  if (!seatProjection) {
    throw new Error(
      `Backend gameplay projection omitted selected player '${options.playerId}'.`,
    );
  }
  const interactionRefs = seatProjection.availableInteractionRefs;
  return {
    perspective: { seat: options.seat },
    flow: {
      phase: options.gameplay.shared.currentPhase,
      step: options.gameplay.shared.currentStage,
      activeSeats: mapBackendPlayerIdsToSeats(
        options.gameplay.shared.activePlayers,
        options.playerIds,
      ),
      pendingSeats: mapBackendPlayerIdsToSeats(
        options.gameplay.shared.simultaneousPhase?.pendingPlayerIds ?? [],
        options.playerIds,
      ),
      continuationWaiterSeats: [],
      blockedBy: [],
    },
    view: parseBackendView(seatProjection.view, options.playerId),
    interactions: interactionRefs.map((ref) => {
      const descriptor = options.gameplay.interactionsByRef[ref];
      if (!descriptor) {
        throw new Error(
          `Backend gameplay projection references missing interaction '${ref}'.`,
        );
      }
      return {
        actorSeat: options.seat,
        interactionId: descriptor.interactionId,
        availability: compactAvailability(descriptor.availability),
        inputs: descriptor.inputs.map((input) =>
          options.scenario.scenarioProjectionInputMetadata(input),
        ),
      };
    }),
  };
}

function compactAvailability(availability: {
  readonly status: string;
  readonly code?: string;
  readonly reason?: string;
}): {
  readonly status: string;
  readonly code?: string;
  readonly reason?: string;
} {
  return {
    status: availability.status,
    ...(typeof availability.code === "string"
      ? { code: availability.code }
      : {}),
    ...(typeof availability.reason === "string"
      ? { reason: availability.reason }
      : {}),
  };
}

function mapBackendPlayerIdsToSeats(
  values: readonly string[],
  playerIds: readonly string[],
): number[] {
  return [
    ...new Set(
      values.map((playerId) => {
        const seat = playerIds.indexOf(playerId);
        if (seat < 0) {
          throw new Error(
            `Backend projection references unknown player '${playerId}'.`,
          );
        }
        return seat;
      }),
    ),
  ].sort((left, right) => left - right);
}

function parseBackendView(value: string | null, playerId: string): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Backend view for '${playerId}' is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function requireBackendPlayerIds(options: {
  readonly snapshot: HostSessionSnapshot;
  readonly expectedCount: number;
  readonly scenario: LoadedReducerNativeScenario;
}): readonly string[] {
  const playerIds = options.snapshot.lobby.seats.map((seat) => seat.playerId);
  if (
    playerIds.length !== options.expectedCount ||
    new Set(playerIds).size !== playerIds.length
  ) {
    throw backendSnapshotError({
      scenario: options.scenario,
      checkpoint: { segment: "setup", completed: 0 },
      message:
        `Backend created ${playerIds.length} unique seat(s) for scenario ` +
        `'${options.scenario.id}', expected ${options.expectedCount}.`,
    });
  }
  return playerIds;
}

function requireGameplaySnapshot(options: {
  readonly snapshot: HostSessionSnapshot;
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly sourceCommand?: ScenarioSourceCommand;
}): Extract<HostSessionSnapshot, { type: "gameplay" }>["gameplay"] {
  if (options.snapshot.type !== "gameplay") {
    throw backendSnapshotError({
      scenario: options.scenario,
      checkpoint: options.checkpoint,
      sourceCommand: options.sourceCommand,
      message:
        `${options.sourceCommand ? formatSourceCommand(options.sourceCommand) : "Scenario setup"} ` +
        `reached backend session state '${options.snapshot.type}' before projection parity could be proven.`,
    });
  }
  return options.snapshot.gameplay;
}

function backendSnapshotError(options: {
  readonly scenario: LoadedReducerNativeScenario;
  readonly checkpoint: ScenarioCheckpointLike;
  readonly message: string;
  readonly sourceCommand?: ScenarioSourceCommand;
  readonly cause?: unknown;
}): ScenarioDevMaterializationError {
  return new ScenarioDevMaterializationError({
    code: "SCENARIO_BACKEND_SNAPSHOT_UNAVAILABLE",
    message: options.message,
    scenarioId: options.scenario.id,
    scenarioPath: options.scenario.scenarioPath,
    checkpoint: options.checkpoint,
    sourceCommand: options.sourceCommand,
    cause: options.cause,
  });
}

function checkpointError(
  message: string,
  checkpoint?: ScenarioCheckpointLike,
): ScenarioDevMaterializationError {
  return new ScenarioDevMaterializationError({
    code: "SCENARIO_CHECKPOINT_INVALID",
    message,
    checkpoint,
  });
}

function formatSourceCommand(source: ScenarioSourceCommand): string {
  return `scenario.${source.segment}[${source.index}]`;
}

async function startBackendSession(
  sessionId: string,
): Promise<HostSessionSnapshot> {
  const { data, error, response } = await startGame({
    path: { sessionId },
  });
  if (error || !data) {
    throw new ScenarioDevMaterializationError({
      code: "SCENARIO_BACKEND_START_FAILED",
      message: `Failed to start backend scenario session '${sessionId}'.`,
      cause: toDreamboardApiError(
        error,
        response,
        "Failed to start backend scenario session",
      ),
    });
  }
  return data;
}

async function readBackendSession(options: {
  readonly sessionId: string;
  readonly playerId: string;
}): Promise<HostSessionSnapshot> {
  const { data, error, response } = await getSessionSnapshot({
    path: { sessionId: options.sessionId },
    query: { playerId: options.playerId },
  });
  if (error || !data) {
    throw new ScenarioDevMaterializationError({
      code: "SCENARIO_BACKEND_SNAPSHOT_UNAVAILABLE",
      message: `Failed to read backend projection for player '${options.playerId}'.`,
      cause: toDreamboardApiError(
        error,
        response,
        "Failed to read backend scenario projection",
      ),
    });
  }
  return data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
