export type DevHostResolvedBearer =
  | {
      readonly kind: "ok";
      readonly token: string | null;
    }
  | {
      readonly kind: "permanent_invalid";
      readonly message: string;
    };

export interface DevHostPlatform {
  resolveBearer(): Promise<DevHostResolvedBearer>;
}

export interface DevHostStartRequestV1 {
  projectRoot: string;
  sessionFilePath: string;
  apiBaseUrl: string;
  port?: number;
  host?: string | boolean;
  allowedHosts?: string[];
  runtimeConfig: DreamboardDevRuntimeConfig;
}

export interface DevHostHandleV1 {
  url: string;
  networkUrls: string[];
  close(): Promise<void>;
}

export interface DevHostModuleV1 {
  protocolVersion: 1;
  start(
    request: DevHostStartRequestV1,
    platform: DevHostPlatform,
  ): Promise<DevHostHandleV1>;
}

export type ActiveSession = {
  sessionId: string;
  shortCode: string;
  gameId: string;
  seed: number | null;
};

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
