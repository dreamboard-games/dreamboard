import type { PlayerCountFlags } from "../flags.js";
import { loadManifest } from "../services/project/local-files.js";
import { parsePositiveInt } from "./strings.js";

export async function resolvePlayerCount(
  projectRoot: string,
  flags: PlayerCountFlags,
): Promise<number> {
  const rawPlayers = flags.players ?? flags["player-count"];
  if (rawPlayers !== undefined) {
    return parsePositiveInt(rawPlayers, "players");
  }

  const manifest = await loadManifest(projectRoot);
  const minPlayers = manifest.players?.minPlayers;
  if (typeof minPlayers !== "number" || !Number.isFinite(minPlayers)) {
    throw new Error(
      "manifest.ts is missing players.minPlayers. Provide --players <count> instead.",
    );
  }

  return Math.max(1, Math.floor(minPlayers));
}
