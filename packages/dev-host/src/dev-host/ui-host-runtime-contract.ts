import type { HostSessionMetadataProps } from "@dreamboard-games/ui-host-runtime/components";
import type {
  GameSessionStoreApi,
  UnifiedSessionStore,
} from "@dreamboard-games/ui-host-runtime/runtime";
import type { ActiveSession } from "./dev-host-storage.js";

type DevHostSessionStore = {
  getState: () => UnifiedSessionStore;
  subscribe: (
    listener: (
      state: UnifiedSessionStore,
      previousState: UnifiedSessionStore,
    ) => void,
  ) => () => void;
};

export function toHostSessionMetadataProps(
  session: ActiveSession,
): HostSessionMetadataProps {
  return {
    projectId: session.projectId,
    sessionId: session.sessionId,
    shortCode: session.shortCode,
  };
}

export function toGameSessionStoreApi(
  store: DevHostSessionStore,
): GameSessionStoreApi {
  return {
    getGameplayFrame: store.getState().getPluginGameplayFrame,
    subscribe: (listener: () => void) =>
      store.subscribe((_state, _previousState) => {
        listener();
      }),
    onStateAck: store.getState().onStateAck,
  };
}
