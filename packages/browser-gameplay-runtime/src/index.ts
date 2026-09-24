import {
  ReducerWireZod,
  type ReducerWire,
} from "@dreamboard-games/sdk/reducer";
import { z } from "zod";
import { createSandbox } from "./sandbox.js";
import type { Operation, WorkerRequest } from "./contract.js";
export interface SavedGame {
  state: ReducerWire.ReducerSessionState;
  terminal: ReducerWire.GameOutcome | null;
}
export interface GameplaySnapshot {
  playerId: string;
  currentPhase: string;
  activePlayers: string[];
  projection: ReducerWire.SeatProjectionBundle;
  boardStatic: ReducerWire.BoardStaticProjection | null;
  terminal: ReducerWire.GameOutcome | null;
  events: ReducerWire.GameEvent[];
}
export interface BrowserGameplayOptions {
  /** Self-contained ESM with the canonical reducer bundle as its default export. */
  reducerSource: string;
  initialize: ReducerWire.InitializeRequest;
  /** Trusted host only: never pass this callback or its data to authored UI. */
  persist: (game: SavedGame) => Promise<void>;
  restored?: SavedGame;
  operationTimeoutMs?: number;
}
/** Full state stays between the trusted host and a separate opaque reducer sandbox.
 * Authored UI receives only the returned selected-seat snapshot. */
export function createBrowserGameplayRuntime(options: BrowserGameplayOptions) {
  let sandbox: ReturnType<typeof createSandbox> | undefined;
  let saved: SavedGame | undefined;
  const initialization = ReducerWireZod.InitializeRequestSchema.parse(
    options.initialize,
  );
  let playerId = initialization.playerIds[0];
  if (!playerId) throw new Error("At least one player is required");
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  function queue<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(() => {
      if (disposed) throw new Error("Game runtime disposed");
      return run();
    });
    tail = result.catch(() => {});
    return result;
  }
  async function call<T>(request: Operation, schema: z.ZodType<T>): Promise<T> {
    sandbox ??= createSandbox(options.operationTimeoutMs ?? 5000);
    const currentSandbox = sandbox;
    try {
      const json = await currentSandbox.execute({
        ...request,
        source: options.reducerSource,
      } as WorkerRequest);
      if (
        typeof json !== "string" ||
        new TextEncoder().encode(json).length > 8 * 1024 * 1024
      )
        throw new Error("Invalid game response");
      return schema.parse(JSON.parse(json));
    } catch (error) {
      currentSandbox.close();
      if (sandbox === currentSandbox) sandbox = undefined;
      throw error;
    }
  }
  async function project(
    game: SavedGame,
    perspective = playerId,
  ): Promise<GameplaySnapshot> {
    const projection = await call(
      {
        operation: "project",
        input: { state: game.state, playerIds: [perspective] },
      },
      ReducerWireZod.SeatProjectionBundleSchema,
    );
    // Even if a reducer returns extra seats, they never cross into the UI bridge.
    const seat = projection.seats[perspective];
    if (!seat) throw new Error("Game did not project the selected seat");
    const boardStatic = await call(
      { operation: "boardStatic" },
      ReducerWireZod.BoardStaticProjectionSchema.nullable(),
    );
    return {
      playerId: perspective,
      currentPhase: game.state.domain.flow.currentPhase,
      activePlayers: game.state.domain.flow.activePlayers,
      projection: { ...projection, seats: { [perspective]: seat } },
      boardStatic,
      terminal: game.terminal,
      events: projection.events,
    };
  }
  async function commit(next: SavedGame) {
    const snapshot = await project(next);
    await options.persist(structuredClone(next));
    if (disposed) throw new Error("Game runtime disposed");
    saved = next;
    return snapshot;
  }
  async function initialize() {
    const result = await call(
      { operation: "initialize", input: initialization },
      ReducerWireZod.InitializeResultSchema,
    );
    return commit({ state: result.state, terminal: result.terminal ?? null });
  }
  function parseCheckpoint(value: unknown): SavedGame {
    const checkpoint = z
      .strictObject({
        state: ReducerWireZod.ReducerSessionStateSchema,
        terminal: ReducerWireZod.GameOutcomeSchema.nullable(),
      })
      .parse(value);
    const table = checkpoint.state.domain.table;
    if (
      !table ||
      typeof table !== "object" ||
      Array.isArray(table) ||
      JSON.stringify(table.playerOrder) !==
        JSON.stringify(initialization.playerIds)
    )
      throw new Error("Checkpoint player roster does not match this session");
    return checkpoint;
  }
  return {
    start: () =>
      queue(async () => {
        if (saved) return project(saved);
        if (options.restored) {
          const next = parseCheckpoint(options.restored);
          const snapshot = await project(next);
          saved = next;
          return snapshot;
        }
        return initialize();
      }),
    dispatch: (value: ReducerWire.GameInput) => {
      const input = ReducerWireZod.GameInputSchema.parse(value);
      return queue(async () => {
        if (!saved) throw new Error("Start the game first");
        if (input.playerId !== playerId)
          throw new Error("Input must belong to the selected seat");
        if (saved.terminal) throw new Error("Game has ended");
        const result = await call(
          { operation: "dispatch", input: { state: saved.state, input } },
          ReducerWireZod.DispatchResultSchema,
        );
        if (result.kind === "reject") return result;
        return {
          kind: "accept" as const,
          snapshot: await commit({
            state: result.state,
            terminal: result.terminal ?? null,
          }),
        };
      });
    },
    checkpoint: () =>
      queue(async () => {
        if (!saved) throw new Error("Start the game first");
        return structuredClone(saved);
      }),
    restore: (value: unknown) => {
      const next = parseCheckpoint(value);
      return queue(() => commit(next));
    },
    selectSeat: (nextPlayerId: string) =>
      queue(async () => {
        if (!initialization.playerIds.includes(nextPlayerId))
          throw new Error("Unknown player");
        if (!saved) throw new Error("Start the game first");
        const snapshot = await project(saved, nextPlayerId);
        playerId = nextPlayerId;
        return snapshot;
      }),
    reset: () =>
      queue(async () => {
        sandbox?.close();
        sandbox = undefined;
        return initialize();
      }),
    dispose: () => {
      disposed = true;
      sandbox?.close();
      sandbox = undefined;
    },
  };
}
export type BrowserGameplayRuntime = ReturnType<
  typeof createBrowserGameplayRuntime
>;
export { PluginBridge } from "./plugin-bridge.js";
export { mountGameplayUI, type GameplayUIOptions } from "./gameplay-ui.js";
