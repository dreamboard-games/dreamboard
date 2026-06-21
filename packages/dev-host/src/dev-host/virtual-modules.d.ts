declare module "virtual:dreamboard-dev-config" {
  export interface DreamboardDevConfig {
    apiBaseUrl: string;
    userId: string | null;
    projectId: string;
    compiledResultId: string;
    setupProfileId: string | null;
    playerCount: number;
    debug: boolean;
    slug: string;
    autoStartGame: boolean;
    initialSession: {
      sessionId: string;
      shortCode: string;
      projectId: string;
      seed: number | null;
    };
  }

  const config: DreamboardDevConfig;
  export default config;
}

declare module "virtual:dreamboard-project-entry" {
  const projectEntry: unknown;
  export default projectEntry;
}
