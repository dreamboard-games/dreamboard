import path from "node:path";
import { getSessionSnapshot } from "@dreamboard-games/api-client";
import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { PROJECT_DIR_NAME } from "../constants.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import {
  findProjectRoot,
  loadProjectConfig,
} from "../config/project-config.js";
import {
  configureClient,
  requireAuth,
  resolveConfig,
} from "../config/resolve.js";
import { parseJoinCommandArgs } from "../flags.js";
import { runJoinJsonlSession } from "../services/join/jsonl-bot-session.js";
import { loadPersistedDevSession } from "../utils/dev-session.js";
import { toDreamboardApiError } from "../utils/errors.js";

export default defineCommand({
  meta: {
    name: "join",
    description: "Join an existing game session as a JSONL bot client",
  },
  args: {
    session: {
      type: "string",
      description:
        "Backend session id to join (defaults to .dreamboard/dev/session.json)",
    },
    player: {
      type: "string",
      description: "Player id this bot controls",
      required: true,
    },
    "raw-events": {
      type: "boolean",
      description:
        "Stream raw backend gameplay events instead of compact bot.gameplay events",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseJoinCommandArgs(args);
    const projectRoot = await findProjectRoot(process.cwd());
    const [globalConfig, storedSession, projectConfig] = await Promise.all([
      loadGlobalConfig(),
      getStoredSession(),
      projectRoot ? loadProjectConfig(projectRoot) : Promise.resolve(undefined),
    ]);
    const config = resolveConfig(
      globalConfig,
      parsedArgs,
      projectConfig,
      storedSession,
    );
    requireAuth(config);
    await configureClient(config);
    const sessionId =
      parsedArgs.session ?? (await resolveDefaultSessionId(projectRoot));
    const playerId = normalizeJoinPlayerId(parsedArgs.player);
    await assertKnownPlayerId(sessionId, playerId);

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await runJoinJsonlSession({
        sessionId,
        playerId,
        rawEvents: parsedArgs["raw-events"],
        signal: abortController.signal,
      });
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  },
});

async function resolveDefaultSessionId(
  projectRoot: string | null,
): Promise<string> {
  if (!projectRoot) {
    throw new Error(
      "No session id provided and this directory is not a Dreamboard project. Pass --session or run from a workspace with .dreamboard/dev/session.json.",
    );
  }

  const sessionFilePath = path.join(
    projectRoot,
    PROJECT_DIR_NAME,
    "dev",
    "session.json",
  );
  const persistedSession = await loadPersistedDevSession(sessionFilePath);
  if (!persistedSession) {
    throw new Error(
      "No session id provided and no Dreamboard dev session was found. Pass --session or run `dreamboard dev` from this project first.",
    );
  }
  return persistedSession.sessionId;
}

function normalizeJoinPlayerId(player: string): string {
  return /^\d+$/.test(player) ? `player-${player}` : player;
}

async function assertKnownPlayerId(
  sessionId: string,
  playerId: string,
): Promise<void> {
  const {
    data: snapshot,
    error,
    response,
  } = await getSessionSnapshot({
    path: { sessionId },
  });
  if (error || !snapshot) {
    throw toDreamboardApiError(
      error,
      response,
      `Failed to load session snapshot for session ${sessionId}.`,
    );
  }

  const playerIds = snapshot.lobby.seats.map((seat) => seat.playerId);
  if (!playerIds.includes(playerId)) {
    throw new Error(
      `Unknown player id '${playerId}' for session ${sessionId}. Available players: ${playerIds.join(", ") || "none"}.`,
    );
  }
}
