import type { GameApis, JsonElement } from "./types.d.ts";
import type { WrappedGameApis } from "./core/apiWrappers.js";
import type {
  ActionName,
  ActionParametersFor,
  NextStateFor,
  PlayerId,
  StateName,
} from "../shared/manifest.d.ts";
import type { StateApi } from "./core/state.d.ts";
import type { Logger } from "./runtime/logger.d.ts";
import type { ValidationResult } from "./runtime/validation.js";

export interface PhaseTrackingApi {
  getExpectedPlayers(): PlayerId[];
  getPlayersWhoActed(): PlayerId[];
  hasPlayerActed(playerId: PlayerId): boolean;
  getPlayersStillWaiting(): PlayerId[];
  haveAllExpectedPlayersActed(): boolean;
}

export interface PhaseContext {
  readonly state: StateApi;
  readonly apis: WrappedGameApis;
  readonly logger: Logger;
  readonly phase: PhaseTrackingApi;
}

export type PlayerAction = {
  [K in ActionName]: {
    type: K;
    parameters: ActionParametersFor<K>;
  };
}[ActionName];

export interface PhaseResult {
  success: boolean;
  nextState?: StateName;
  errorMessage?: string;
}

/**
 * AUTO Phase Handler - For phases that run automatically without player input.
 *
 * Lifecycle: execute (runs immediately, no UI state needed)
 *
 * The `execute` method combines processing and transition decision into one
 * atomic operation, preventing timing bugs where state changes affect
 * transition logic unexpectedly.
 *
 * Note: AUTO phases do not have getUIArgs since they execute immediately
 * without waiting for player input or displaying intermediate state.
 */
export interface AutoPhaseHandler<S extends StateName> {
  readonly phaseType: "auto";

  /**
   * Execute the auto phase logic and return the next phase.
   * All state mutations and transition decisions happen here.
   */
  execute(ctx: PhaseContext): NextStateFor<S>;
}

/**
 * SINGLE_PLAYER Phase Handler - For phases where one player acts at a time.
 *
 * Lifecycle: onEnter -> [validateAction -> onPlayerAction -> onAfterAction]* -> checkCompletion -> onComplete
 *
 * The `checkCompletion` method combines completion check and transition decision
 * into one atomic operation. Returns null if not complete, or the next phase if complete.
 */
export interface SinglePlayerPhaseHandler<
  S extends StateName,
  A extends ActionName = ActionName,
  U = object,
> {
  readonly phaseType: "single_player";

  /**
   * Called once when entering the phase. Use for initialization.
   */
  onEnter?(ctx: PhaseContext): void;

  /**
   * Validate a player action before execution.
   * Return validationSuccess() or validationError(code, message).
   */
  validateAction(
    ctx: PhaseContext,
    playerId: PlayerId,
    actionType: A,
    parameters: ActionParametersFor<A>,
  ): ValidationResult;

  /**
   * Process a player action. Called after validation passes.
   */
  onPlayerAction(
    ctx: PhaseContext,
    playerId: PlayerId,
    actionType: A,
    parameters: ActionParametersFor<A>,
  ): void;

  /**
   * Called after every action, regardless of phase completion.
   * Use for per-action side effects like advancing to next player in looping phases.
   */
  onAfterAction?(ctx: PhaseContext, playerId: PlayerId, actionType: A): void;

  /**
   * Check if the phase should complete and determine the next phase.
   * Returns null if not complete, or the next phase name if complete.
   * This combines isComplete + getNextPhase into one atomic decision.
   */
  checkCompletion(ctx: PhaseContext): NextStateFor<S> | null;

  /**
   * Called after checkCompletion returns a next phase.
   * Use for cleanup that doesn't affect transition logic.
   */
  onComplete?(ctx: PhaseContext): void;

  /**
   * Get UI arguments to display during this phase for a specific player.
   * @param ctx - Phase context for reading state
   * @param playerId - Player ID to get UI arguments for
   */
  getUIArgs?(ctx: PhaseContext, playerId: PlayerId): U;
}

/**
 * MULTIPLE_PLAYER Phase Handler - For phases where all players act simultaneously.
 *
 * Lifecycle: onEnter -> [validateAction -> onPlayerAction -> onAfterAction?]* (per player) -> checkCompletion -> onComplete
 *
 * The `checkCompletion` method combines completion check and transition decision
 * into one atomic operation. Returns null if not complete, or the next phase if complete.
 */
export interface MultiplePlayerPhaseHandler<
  S extends StateName,
  A extends ActionName = ActionName,
  U = object,
> {
  readonly phaseType: "multiple_player";

  /**
   * Called once when entering the phase. Use for initialization.
   */
  onEnter?(ctx: PhaseContext): void;

  /**
   * Validate a player action before execution.
   * Return validationSuccess() or validationError(code, message).
   */
  validateAction(
    ctx: PhaseContext,
    playerId: PlayerId,
    actionType: A,
    parameters: ActionParametersFor<A>,
  ): ValidationResult;

  /**
   * Process a player action. Called after validation passes.
   */
  onPlayerAction(
    ctx: PhaseContext,
    playerId: PlayerId,
    actionType: A,
    parameters: ActionParametersFor<A>,
  ): void;

  /**
   * Called after every action, regardless of phase completion.
   * Use for per-action side effects.
   */
  onAfterAction?(ctx: PhaseContext, playerId: PlayerId, actionType: A): void;

  /**
   * Check if the phase should complete and determine the next phase.
   * Returns null if not complete, or the next phase name if complete.
   * This combines isComplete + getNextPhase into one atomic decision.
   */
  checkCompletion(ctx: PhaseContext): NextStateFor<S> | null;

  /**
   * Called after checkCompletion returns a next phase.
   * Use for cleanup that doesn't affect transition logic.
   */
  onComplete?(ctx: PhaseContext): void;

  /**
   * Get UI arguments to display during this phase for a specific player.
   * @param ctx - Phase context for reading state
   * @param playerId - Player ID to get UI arguments for
   */
  getUIArgs?(ctx: PhaseContext, playerId: PlayerId): U;
}

/** Definition type for AUTO phases. Use with `satisfies AutoPhaseDefinition<"stateName">`. */
export type AutoPhaseDefinition<S extends StateName> = Omit<
  AutoPhaseHandler<S>,
  "phaseType"
>;

/** Definition type for terminal AUTO phases (no transitions, game ends). */
export type TerminalPhaseDefinition<S extends StateName> = {
  execute(ctx: PhaseContext): S;
};

/** Definition type for SINGLE_PLAYER phases. Use with `satisfies SinglePlayerPhaseDefinition<"stateName", "actionName">`. */
export type SinglePlayerPhaseDefinition<
  S extends StateName,
  A extends ActionName = ActionName,
  U = object,
> = Omit<SinglePlayerPhaseHandler<S, A, U>, "phaseType">;

/** Definition type for MULTIPLE_PLAYER phases. Use with `satisfies MultiplePlayerPhaseDefinition<"stateName", "actionName">`. */
export type MultiplePlayerPhaseDefinition<
  S extends StateName,
  A extends ActionName = ActionName,
  U = object,
> = Omit<MultiplePlayerPhaseHandler<S, A, U>, "phaseType">;

/**
 * Core interface for phase handlers (used by the runtime).
 * This is the unified interface that the engine works with.
 */
export interface PhaseHandler {
  /** For player phases: called when entering the phase */
  onEnter?(ctx: PhaseContext): void;

  /** For player phases: validate action before execution */
  validateAction?(
    ctx: PhaseContext,
    playerId: PlayerId,
    action: PlayerAction,
  ): ValidationResult;

  /** For player phases: process a player action */
  onPlayerAction?(
    ctx: PhaseContext,
    playerId: PlayerId,
    action: PlayerAction,
  ): void;

  /** For player phases: called after every action */
  onAfterAction?(
    ctx: PhaseContext,
    playerId: PlayerId,
    actionType: ActionName,
  ): void;

  /**
   * For player phases: check completion and get next phase atomically.
   * Returns null if not complete, or next phase name if complete.
   */
  checkCompletion?(ctx: PhaseContext): StateName | null;

  /** For player phases: cleanup after transition decision */
  onComplete?(ctx: PhaseContext): void;

  /**
   * For AUTO phases: execute and return next phase.
   * This is called instead of onEnter + checkCompletion for AUTO phases.
   */
  execute?(ctx: PhaseContext): StateName;

  /**
   * Get UI arguments for the current phase for a specific player.
   * @param ctx - Phase context for reading state
   * @param playerId - Player ID to get UI arguments for
   */
  getUIArgs?(ctx: PhaseContext, playerId: PlayerId): object;
}

export type PhaseHandlers = {
  [S in StateName]?: PhaseHandler;
};

const noopVoid = () => {};
const noopValidation = (): ValidationResult => ({ valid: true });

/** Create a PhaseHandler from an AutoPhaseDefinition. */
export function createAutoPhase<S extends StateName>(
  handler: Omit<AutoPhaseHandler<S>, "phaseType">,
): PhaseHandler {
  return {
    // AUTO phases use execute instead of onEnter + checkCompletion
    execute: handler.execute as (ctx: PhaseContext) => StateName,

    // AUTO phases don't have getUIArgs - they execute immediately
    getUIArgs: undefined,

    // AUTO phases never call the event-style handlers below.
    onEnter: noopVoid,
    validateAction: noopValidation,
    onPlayerAction: noopVoid,
    onAfterAction: noopVoid,
    checkCompletion: () => null,
    onComplete: noopVoid,
  };
}

/** Create a PhaseHandler from a TerminalPhaseDefinition. */
export function createTerminalPhase<S extends StateName>(
  handler: TerminalPhaseDefinition<S>,
): PhaseHandler {
  return {
    execute: handler.execute as (ctx: PhaseContext) => StateName,
    getUIArgs: undefined,
    onEnter: noopVoid,
    validateAction: noopValidation,
    onPlayerAction: noopVoid,
    onAfterAction: noopVoid,
    checkCompletion: () => null,
    onComplete: noopVoid,
  };
}

/** Create a PhaseHandler from a SinglePlayerPhaseDefinition. */
export function createSinglePlayerPhase<
  S extends StateName,
  A extends ActionName = ActionName,
  U extends object = object,
>(handler: Omit<SinglePlayerPhaseHandler<S, A, U>, "phaseType">): PhaseHandler {
  return {
    onEnter: handler.onEnter ?? noopVoid,
    validateAction: (ctx, playerId, action) =>
      handler.validateAction(
        ctx,
        playerId,
        action.type as A,
        action.parameters as ActionParametersFor<A>,
      ),
    onPlayerAction: (ctx, playerId, action) =>
      handler.onPlayerAction(
        ctx,
        playerId,
        action.type as A,
        action.parameters as ActionParametersFor<A>,
      ),
    onAfterAction: handler.onAfterAction
      ? (ctx, playerId, actionType) =>
          handler.onAfterAction!(ctx, playerId, actionType as A)
      : noopVoid,
    checkCompletion: handler.checkCompletion as (
      ctx: PhaseContext,
    ) => StateName | null,
    onComplete: handler.onComplete ?? noopVoid,
    getUIArgs: handler.getUIArgs as
      | ((ctx: PhaseContext, playerId: PlayerId) => object)
      | undefined,

    // Not used for player phases
    execute: undefined,
  };
}

/** Create a PhaseHandler from a MultiplePlayerPhaseDefinition. */
export function createMultiplePlayerPhase<
  S extends StateName,
  A extends ActionName = ActionName,
  U extends object = object,
>(
  handler: Omit<MultiplePlayerPhaseHandler<S, A, U>, "phaseType">,
): PhaseHandler {
  return {
    onEnter: handler.onEnter ?? noopVoid,
    validateAction: (ctx, playerId, action) =>
      handler.validateAction(
        ctx,
        playerId,
        action.type as A,
        action.parameters as ActionParametersFor<A>,
      ),
    onPlayerAction: (ctx, playerId, action) =>
      handler.onPlayerAction(
        ctx,
        playerId,
        action.type as A,
        action.parameters as ActionParametersFor<A>,
      ),
    onAfterAction: handler.onAfterAction
      ? (ctx, playerId, actionType) =>
          handler.onAfterAction!(ctx, playerId, actionType as A)
      : noopVoid,
    checkCompletion: handler.checkCompletion as (
      ctx: PhaseContext,
    ) => StateName | null,
    onComplete: handler.onComplete ?? noopVoid,
    getUIArgs: handler.getUIArgs as
      | ((ctx: PhaseContext, playerId: PlayerId) => object)
      | undefined,

    // Not used for player phases
    execute: undefined,
  };
}
