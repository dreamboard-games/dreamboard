import type {
  InteractionResult,
  SubmitInteractionCommand,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { HostSessionWireEvent } from "./session-ingress.js";

export type GameplayConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "refreshing"
  | "reconnecting"
  | "switching-perspective"
  | "closed";

export interface GameplayConnectionHandlers {
  onEvent(event: HostSessionWireEvent): void;
  onStateChange(state: GameplayConnectionState): void;
  onRecovering?(input: {
    message: string;
    retryAfterMs: number;
    attempt: number;
  }): void;
  onError?(error: unknown): void;
}

export interface GameplayConnection {
  readonly state: GameplayConnectionState;
  connect(input: {
    sessionId: string;
    websocketUrl: string;
    playerId: string;
    switchablePlayerIds: readonly string[];
    lastSeenLogCursor?: number | null;
    handlers: GameplayConnectionHandlers;
  }): Promise<void>;
  switchPerspective(playerId: string): Promise<void>;
  submit(command: SubmitInteractionCommand): Promise<InteractionResult>;
  restoreHistory(input: { targetVersion: number }): Promise<void>;
  close(): void;
}
