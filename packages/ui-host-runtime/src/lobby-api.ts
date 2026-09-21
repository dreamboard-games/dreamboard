import {
  getDemoSessionByShortCode,
  getDemoSessionSnapshot,
  getSessionByShortCode,
  getSessionSnapshot,
  startDemoGame,
  startGame,
  type SessionControlSnapshot,
} from "@dreamboard-games/api-client";

export interface LobbyApi {
  loadByShortCode(input: {
    shortCode: string;
    requestedPlayerId?: string | null;
  }): Promise<SessionControlSnapshot>;
  load(input: {
    sessionId: string;
    requestedPlayerId?: string | null;
  }): Promise<SessionControlSnapshot>;
  start(input: { sessionId: string }): Promise<SessionControlSnapshot>;
  createDevSessionSnapshot?(input: {
    seed?: number | null;
  }): Promise<SessionControlSnapshot>;
}

async function requireData<T>(
  result: { data?: T; error?: unknown },
  message: string,
): Promise<T> {
  if (result.error || !result.data) {
    throw result.error ?? new Error(message);
  }
  return result.data;
}

export const defaultLobbyApi: LobbyApi = {
  async loadByShortCode(input) {
    return requireData(
      await getSessionByShortCode({
        path: { shortCode: input.shortCode },
        query: input.requestedPlayerId
          ? { playerId: input.requestedPlayerId }
          : undefined,
      }),
      "Failed to load session by short code",
    );
  },
  async load(input) {
    return requireData(
      await getSessionSnapshot({
        path: { sessionId: input.sessionId },
        query: input.requestedPlayerId
          ? { playerId: input.requestedPlayerId }
          : undefined,
      }),
      "Failed to load session snapshot",
    );
  },
  async start(input) {
    return requireData(
      await startGame({ path: { sessionId: input.sessionId } }),
      "Failed to start session",
    );
  },
};

export const demoLobbyApi: LobbyApi = {
  ...defaultLobbyApi,
  async loadByShortCode(input) {
    return requireData(
      await getDemoSessionByShortCode({
        path: { shortCode: input.shortCode },
        query: input.requestedPlayerId
          ? { playerId: input.requestedPlayerId }
          : undefined,
      }),
      "Failed to load demo session by short code",
    );
  },
  async load(input) {
    return requireData(
      await getDemoSessionSnapshot({
        path: { sessionId: input.sessionId },
        query: input.requestedPlayerId
          ? { playerId: input.requestedPlayerId }
          : undefined,
      }),
      "Failed to load demo session snapshot",
    );
  },
  async start(input) {
    return requireData(
      await startDemoGame({ path: { sessionId: input.sessionId } }),
      "Failed to start demo session",
    );
  },
};
