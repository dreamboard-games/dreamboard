import type { ActiveSession } from "./dev-host-storage.js";

export interface DreamboardDevRuntimeConfig {
  apiBaseUrl: string;
  userId: string | null;
  gameId: string;
  compiledResultId: string;
  setupProfileId: string | null;
  playerCount: number;
  debug: boolean;
  slug: string;
  autoStartGame: boolean;
  initialSession: ActiveSession;
}
