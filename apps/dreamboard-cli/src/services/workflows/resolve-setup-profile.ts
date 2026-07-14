import type {
  GameTopologyManifest,
  SetupProfileSpec,
} from "@dreamboard-games/sdk/types";
import { loadManifest } from "../project/local-files.js";

export type ResolvedSetupProfileSelection = {
  id: string | null;
  name: string | null;
  source: "explicit" | "implicit-single" | "implicit-first" | "none";
};

export function resolveSetupProfileSelection(options: {
  manifest: GameTopologyManifest;
  requestedSetupProfileId?: string;
}): ResolvedSetupProfileSelection {
  const setupProfiles: SetupProfileSpec[] =
    options.manifest.setupProfiles ?? [];
  const requestedSetupProfileId =
    options.requestedSetupProfileId?.trim() || undefined;

  if (requestedSetupProfileId) {
    const requestedProfile = setupProfiles.find(
      (profile) => profile.id === requestedSetupProfileId,
    );
    if (!requestedProfile) {
      const knownProfiles = setupProfiles
        .map((profile) => profile.id)
        .join(", ");
      throw new Error(
        setupProfiles.length === 0
          ? `Unknown setup profile '${requestedSetupProfileId}'. The manifest defines no setup profiles.`
          : `Unknown setup profile '${requestedSetupProfileId}'. Expected one of: ${knownProfiles}.`,
      );
    }
    return {
      id: requestedProfile.id,
      name: requestedProfile.name,
      source: "explicit",
    };
  }

  if (setupProfiles.length === 0) {
    return {
      id: null,
      name: null,
      source: "none",
    };
  }

  if (setupProfiles.length === 1) {
    return {
      id: setupProfiles[0]?.id ?? null,
      name: setupProfiles[0]?.name ?? null,
      source: "implicit-single",
    };
  }

  return {
    id: setupProfiles[0]?.id ?? null,
    name: setupProfiles[0]?.name ?? null,
    source: "implicit-first",
  };
}

export async function resolveSetupProfileSelectionForSession(options: {
  projectRoot: string;
  requestedSetupProfileId?: string;
}): Promise<ResolvedSetupProfileSelection> {
  const manifest = await loadManifest(options.projectRoot);
  return resolveSetupProfileSelection({
    manifest,
    requestedSetupProfileId: options.requestedSetupProfileId,
  });
}

export async function resolveSetupProfileIdForSession(options: {
  projectRoot: string;
  requestedSetupProfileId?: string;
}): Promise<string | null> {
  return (
    await resolveSetupProfileSelectionForSession({
      projectRoot: options.projectRoot,
      requestedSetupProfileId: options.requestedSetupProfileId,
    })
  ).id;
}
