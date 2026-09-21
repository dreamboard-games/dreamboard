import type { PluginGameplayFrame } from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { GameSessionStoreApi } from "../plugin-session-gateway.js";

export function createStaticStoreApi(
  frame: PluginGameplayFrame,
): GameSessionStoreApi {
  const frozenFrame = deepFreeze(frame);
  return {
    getGameplayFrame: () => frozenFrame,
    subscribe: () => () => undefined,
    onStateAck: () => undefined,
  };
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}
