import path from "node:path";
import type {
  GameTopologyManifest,
  SetupProfileSpec,
} from "@dreamboard-games/sdk/types";
import { isPerPlayer, perPlayerSchema } from "@dreamboard-games/sdk/reducer";
import {
  type ReducerBundleContract,
  type ReducerWire as Wire,
} from "@dreamboard-games/sdk/reducer-contract";
import { materializeManifestTable } from "@dreamboard-games/sdk/codegen";
import { z } from "zod";
import { importTypeScriptModule } from "../../utils/ts-module-loader.js";

// Opt in to SDK authoring warnings (e.g. concrete dependent-choice defaults).
// Trusted reducer code cannot read process.env, so the SDK gates authoring
// warnings on this host-set global instead.
(globalThis as Record<string, unknown>).__DREAMBOARD_AUTHORING_WARNINGS__ =
  true;

/**
 * Path to the reducer bundle entry, relative to the project root. Matches
 * the scaffold produced by `dreamboard new`.
 */
const REDUCER_BUNDLE_ENTRY_PATH = path.join("app", "index.ts");

/**
 * Deterministic rng seed used to drive the reducer during preflight.
 * Kept stable so local preflight failures reproduce across CLI runs.
 */
const PREFLIGHT_RNG_SEED = 1337;

/**
 * Phase of the preflight smoke test that a failure occurred in.
 */
export type ReducerBundleSmokePhase =
  | "BUILD_GAME_STATE"
  | "INITIALIZE"
  | "PROJECT_SEATS"
  | "VALIDATE_VIEW";

export interface ReducerBundleSmokeScenario {
  readonly setupProfileId: string | null;
  readonly playerCount: number;
}

export interface ReducerBundleSmokeFailure {
  readonly scenario: ReducerBundleSmokeScenario;
  readonly phase: ReducerBundleSmokePhase;
  readonly playerId?: string;
  readonly headline: string;
  readonly detail?: string;
}

/**
 * Shape of a single seat's slice in `projectSeatsDynamic(...)`. Only `view`
 * is consumed by the preflight, but the full wire DTO keeps local tests
 * aligned with the canonical reducer boundary.
 */
export type ReducerBundleSeatProjection = Wire.SeatProjection;

/** Result of calling `bundle.projectSeatsDynamic({ state, playerIds })`. */
export type ReducerBundleSeatProjectionBundle = Wire.SeatProjectionBundle;

/**
 * Minimal structural shape the preflight needs from the authored reducer
 * bundle. Matches the subset of `createReducerBundle(game)` used by the
 * reducer runtime.
 */
export type ReducerBundleLike = Pick<
  ReducerBundleContract,
  "initialize" | "projectSeatsDynamic"
>;

function buildPlayerIds(playerCount: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= playerCount; index += 1) {
    ids.push(`player-${index}`);
  }
  return ids;
}

/**
 * Build the matrix of scenarios to drive. Exported for tests so we can
 * assert scenario generation without loading a full reducer bundle.
 */
export function buildScenarios(
  manifest: GameTopologyManifest,
): ReducerBundleSmokeScenario[] {
  const rawCounts = [
    manifest.players?.minPlayers,
    manifest.players?.maxPlayers,
  ].filter(
    (count): count is number =>
      typeof count === "number" && Number.isFinite(count) && count > 0,
  );
  const playerCounts = Array.from(new Set(rawCounts));
  if (playerCounts.length === 0) {
    return [];
  }
  const profiles: SetupProfileSpec[] = manifest.setupProfiles ?? [];
  const profileIds: Array<string | null> =
    profiles.length > 0 ? profiles.map((profile) => profile.id) : [null];

  const scenarios: ReducerBundleSmokeScenario[] = [];
  const seen = new Set<string>();
  for (const profileId of profileIds) {
    for (const count of playerCounts) {
      const key = `${profileId ?? "<default>"}:${count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scenarios.push({ setupProfileId: profileId, playerCount: count });
    }
  }
  return scenarios;
}

function describeScenario(scenario: ReducerBundleSmokeScenario): string {
  const profileDesc = scenario.setupProfileId
    ? `setup profile '${scenario.setupProfileId}'`
    : "no setup profile";
  return `${profileDesc}, ${scenario.playerCount} player${
    scenario.playerCount === 1 ? "" : "s"
  }`;
}

function summarizeError(error: unknown): { headline: string; detail?: string } {
  if (error instanceof Error) {
    const firstLine =
      error.message
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "Unknown failure";
    const detail =
      error.stack && error.stack !== error.message ? error.stack : undefined;
    return { headline: firstLine, detail };
  }
  return { headline: String(error ?? "Unknown failure") };
}

/**
 * Walk `view` recursively and, for every embedded `PerPlayer<T>` shape,
 * assert its seat list matches `expectedPlayerIds` using
 * `perPlayerSchema({ players })`. Returns `null` on success, or a headline
 * describing the first mismatch.
 *
 * This catches the class of bug where an author returns a `PerPlayer<T>`
 * that was built from the wrong seat list (e.g. a manifest-derived
 * `maxPlayers` literal union) while the runtime session has a different
 * number of seats. The Zod bound schema produces an identical error shape
 * to the one the backend raises in production so authors see the same
 * diagnostic locally.
 */
export function assertViewPerPlayerSeatsValid(
  view: unknown,
  expectedPlayerIds: readonly string[],
  breadcrumb: string[] = [],
): string | null {
  if (view === null || view === undefined) {
    return null;
  }

  if (isPerPlayer(view)) {
    const schema = perPlayerSchema(z.unknown(), {
      players: expectedPlayerIds as never,
    });
    const result = schema.safeParse(view);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const location =
        breadcrumb.length > 0 ? ` at view.${breadcrumb.join(".")}` : "";
      const message = firstIssue?.message ?? "PerPlayer seat mismatch";
      return `PerPlayer seat mismatch${location}: ${message}`;
    }
    return null;
  }

  if (Array.isArray(view)) {
    for (let index = 0; index < view.length; index += 1) {
      const result = assertViewPerPlayerSeatsValid(
        view[index],
        expectedPlayerIds,
        [...breadcrumb, `[${index}]`],
      );
      if (result) return result;
    }
    return null;
  }

  if (typeof view === "object") {
    for (const [key, value] of Object.entries(
      view as Record<string, unknown>,
    )) {
      const result = assertViewPerPlayerSeatsValid(value, expectedPlayerIds, [
        ...breadcrumb,
        key,
      ]);
      if (result) return result;
    }
    return null;
  }

  return null;
}

function identityShuffle<Value>(values: readonly Value[]): Value[] {
  return [...values];
}

/**
 * Drive an already-loaded reducer bundle through the provided scenarios.
 * Shared between the full `runReducerBundleSmoke` entrypoint and the
 * unit tests, which feed a fake bundle directly.
 *
 * For each (setup profile × player count) scenario this:
 *
 *   1. materializes an initial table via `materializeManifestTable`,
 *   2. calls `bundle.initialize({ table, playerIds, rngSeed, setup })`,
 *   3. calls `bundle.projectSeatsDynamic({ state, playerIds })` once, and
 *   4. validates any embedded `PerPlayer<T>` views match the runtime seat
 *      list using `perPlayerSchema({ players: playerIds })`.
 *
 * Failures are collected instead of thrown so authors get the full list
 * of broken scenarios in one preflight pass.
 */
export async function driveReducerBundleThroughScenarios(options: {
  manifest: GameTopologyManifest;
  bundle: ReducerBundleLike;
  scenarios: readonly ReducerBundleSmokeScenario[];
  rngSeed?: number;
}): Promise<ReducerBundleSmokeFailure[]> {
  const { manifest, bundle, scenarios } = options;
  const rngSeed = options.rngSeed ?? PREFLIGHT_RNG_SEED;

  const failures: ReducerBundleSmokeFailure[] = [];
  const tableCache = new Map<
    number,
    { table: unknown; playerIds: string[] } | { error: unknown }
  >();

  for (const scenario of scenarios) {
    let tableEntry = tableCache.get(scenario.playerCount);
    if (!tableEntry) {
      try {
        const playerIds = buildPlayerIds(scenario.playerCount);
        // JSON-roundtrip the materialized table to mirror the backend wire
        // boundary: real flows serialize the table over HTTP, which drops
        // explicit `undefined` property values (e.g. optional card text) that
        // the bundle's strict JSON state schema would otherwise reject.
        const table: unknown = JSON.parse(
          JSON.stringify(
            materializeManifestTable({
              manifest,
              playerIds,
              shuffleItems: identityShuffle,
            }),
          ),
        );
        tableEntry = { table, playerIds };
      } catch (error) {
        tableEntry = { error };
      }
      tableCache.set(scenario.playerCount, tableEntry);
    }
    if ("error" in tableEntry) {
      const summary = summarizeError(tableEntry.error);
      failures.push({
        scenario,
        phase: "BUILD_GAME_STATE",
        headline: summary.headline,
        detail: summary.detail,
      });
      continue;
    }

    const { table, playerIds } = tableEntry;

    let sessionState: unknown;
    try {
      sessionState = await bundle.initialize({
        table: table as Wire.JsonValue,
        playerIds: [...playerIds],
        rngSeed,
        setup: scenario.setupProfileId
          ? { profileId: scenario.setupProfileId, optionValues: {} }
          : null,
      });
    } catch (error) {
      const summary = summarizeError(error);
      failures.push({
        scenario,
        phase: "INITIALIZE",
        headline: summary.headline,
        detail: summary.detail,
      });
      continue;
    }

    let projection: ReducerBundleSeatProjectionBundle | undefined;
    try {
      projection = bundle.projectSeatsDynamic({
        state: sessionState as Wire.ReducerSessionState,
        playerIds: [...playerIds],
      });
    } catch (error) {
      const summary = summarizeError(error);
      failures.push({
        scenario,
        phase: "PROJECT_SEATS",
        headline: summary.headline,
        detail: summary.detail,
      });
      continue;
    }

    const seats = projection?.seats ?? {};
    for (const playerId of playerIds) {
      const seat = seats[playerId];
      if (!seat) {
        failures.push({
          scenario,
          phase: "PROJECT_SEATS",
          playerId,
          headline: `projectSeatsDynamic() did not return an entry for seat '${playerId}'.`,
        });
        continue;
      }
      const mismatch = assertViewPerPlayerSeatsValid(seat.view, playerIds);
      if (mismatch) {
        failures.push({
          scenario,
          phase: "VALIDATE_VIEW",
          playerId,
          headline: mismatch,
        });
      }
    }
  }

  return failures;
}

/**
 * Import the authored reducer bundle from `projectRoot/app/index.ts` and
 * drive it through every (setup profile × player count) scenario the
 * manifest declares. Returns the collected failures without throwing so
 * callers can decide whether to surface them.
 */
export async function runReducerBundleSmoke(options: {
  projectRoot: string;
  manifest: GameTopologyManifest;
}): Promise<ReducerBundleSmokeFailure[]> {
  const { projectRoot, manifest } = options;
  const scenarios = buildScenarios(manifest);
  if (scenarios.length === 0) {
    return [];
  }

  const entryPath = path.join(projectRoot, REDUCER_BUNDLE_ENTRY_PATH);
  let module: { default?: ReducerBundleLike };
  try {
    module = await importTypeScriptModule<{ default?: ReducerBundleLike }>(
      entryPath,
    );
  } catch (error) {
    const summary = summarizeError(error);
    throw new Error(
      [
        `Dreamboard could not import \`${REDUCER_BUNDLE_ENTRY_PATH}\` during \`dreamboard sync\`.`,
        "Fix the reducer bundle entry so it can be imported locally, then run `dreamboard sync` again.",
        `Original error: ${summary.headline}`,
      ].join(" "),
    );
  }
  const bundle = module.default;
  if (!bundle || typeof bundle.initialize !== "function") {
    throw new Error(
      [
        `\`${REDUCER_BUNDLE_ENTRY_PATH}\` does not export a reducer bundle as its default export.`,
        "Export `createReducerBundle(game)` from `app/index.ts` so the compile pipeline can smoke-test it.",
      ].join(" "),
    );
  }

  return driveReducerBundleThroughScenarios({ manifest, bundle, scenarios });
}

function formatFailureLines(
  failures: readonly ReducerBundleSmokeFailure[],
): string {
  return failures
    .map((failure) => {
      const location = failure.playerId ? ` (seat ${failure.playerId})` : "";
      return `• [${failure.phase}] ${describeScenario(failure.scenario)}${location}: ${failure.headline}`;
    })
    .join("\n");
}

/**
 * Preflight wrapper used by `dreamboard sync`. Runs
 * `runReducerBundleSmoke` and throws an aggregated error if any scenario
 * failed so the author sees every broken seat/profile in one shot.
 *
 * Sync already guarantees that the authored contract imports cleanly
 * (via `assertReducerContractPreflight`) and that `tsc --noEmit` is
 * green (via `runLocalTypecheck`) before this runs, so failures from
 * this step are always runtime-shaped (`initialize`/`projectSeatsDynamic` rejecting,
 * `perPlayer` seat mismatches, …) rather than static type or import
 * errors.
 */
export async function assertReducerBundleSmoke(options: {
  projectRoot: string;
  manifest: GameTopologyManifest;
}): Promise<void> {
  const failures = await runReducerBundleSmoke(options);
  if (failures.length === 0) {
    return;
  }
  throw new Error(
    [
      "Reducer bundle preflight failed during `dreamboard sync`.",
      "Fix the reported scenarios locally before syncing so the backend does not catch them after start-game:",
      formatFailureLines(failures),
    ].join("\n"),
  );
}
