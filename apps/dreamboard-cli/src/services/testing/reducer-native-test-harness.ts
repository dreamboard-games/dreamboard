/**
 * Compatibility import surface for CLI consumers.
 *
 * Scenario loading and execution intentionally live in small focused modules;
 * this file no longer owns a reducer runtime or generated test artifacts.
 */
export {
  NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR,
  ScenarioLoaderError,
  discoverReducerNativeScenarioPaths,
  loadReducerNativeScenarios,
  type LoadedReducerNativeScenario,
  type ScenarioLoaderErrorCode,
} from "./scenario-loader.js";
export {
  isReducerNativeTestingWorkspace,
  runReducerNativeScenarios,
  type ReducerNativeScenarioResult,
  type ReducerNativeScenarioSummary,
} from "./scenario-test-runner.js";
