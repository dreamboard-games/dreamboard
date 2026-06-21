export type ActiveSession = {
  sessionId: string;
  shortCode: string;
  projectId: string;
  seed: number | null;
};

export interface DevHostStorage {
  loadSidebarOpen(): boolean;
  persistSidebarOpen(open: boolean): void;
  loadPreferredPlayerId(): string | null;
  persistPreferredPlayerId(playerId: string | null): void;
}

const SIDEBAR_STORAGE_KEY = "dreamboard-dev-sidebar";
const PREFERRED_PLAYER_STORAGE_KEY = "dreamboard-dev-preferred-player";

export class SessionStorageDevHostStorage implements DevHostStorage {
  constructor(private readonly storage: Storage) {}

  loadSidebarOpen(): boolean {
    try {
      return this.storage.getItem(SIDEBAR_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  }

  persistSidebarOpen(open: boolean): void {
    try {
      this.storage.setItem(SIDEBAR_STORAGE_KEY, String(open));
    } catch {
      // Ignore persistence failures in locked-down browser contexts.
    }
  }

  loadPreferredPlayerId(): string | null {
    try {
      return this.storage.getItem(PREFERRED_PLAYER_STORAGE_KEY)?.trim() || null;
    } catch {
      return null;
    }
  }

  persistPreferredPlayerId(playerId: string | null): void {
    try {
      if (playerId?.trim()) {
        this.storage.setItem(PREFERRED_PLAYER_STORAGE_KEY, playerId.trim());
      } else {
        this.storage.removeItem(PREFERRED_PLAYER_STORAGE_KEY);
      }
    } catch {
      // Ignore persistence failures in locked-down browser contexts.
    }
  }
}
