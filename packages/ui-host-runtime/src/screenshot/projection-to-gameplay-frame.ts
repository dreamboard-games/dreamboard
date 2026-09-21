import {
  materializePluginGameplayFrame,
  type InteractionDescriptor,
  type PluginGameplayFrame,
  type RuntimeJson,
  type SimultaneousPhaseSnapshot,
  type ZoneHandlesSnapshot,
} from "@dreamboard-games/sdk/plugin-runtime-contract";

const DEFAULT_PLAYER_IDS = [
  "player-1",
  "player-2",
  "player-3",
  "player-4",
] as const;

export interface ScreenshotProjection {
  currentPhase?: string | null;
  currentStage?: string | null;
  stageSeats?: string[];
  simultaneousPhase?: SimultaneousPhaseSnapshot | null;
  view?: unknown;
  availableInteractions?: readonly InteractionDescriptor[];
  zones?: Readonly<Record<string, ZoneHandlesSnapshot>>;
}

export interface ProjectionToGameplayFrameOptions {
  controllingPlayerId?: string;
  playerIds?: string[];
  gameVersion?: number;
  actionSetVersion?: string;
}

export function projectionToGameplayFrame(
  projection: ScreenshotProjection,
  options: ProjectionToGameplayFrameOptions = {},
): PluginGameplayFrame {
  const controllingPlayerId =
    options.controllingPlayerId ??
    projection.stageSeats?.[0] ??
    DEFAULT_PLAYER_IDS[0];
  const { interactionsByRef, availableInteractionRefs, zonesByRef } =
    interactionRefsForFrame(
      projection.availableInteractions ?? [],
      projection.zones ?? {},
    );

  return materializePluginGameplayFrame({
    currentPhase:
      projection.currentPhase ??
      viewCurrentPhase(projection.view) ??
      projection.currentStage ??
      null,
    activePlayers:
      projection.stageSeats && projection.stageSeats.length > 0
        ? projection.stageSeats
        : [controllingPlayerId],
    perspectivePlayerId: controllingPlayerId,
    version: options.gameVersion ?? 1,
    actionSetVersion: options.actionSetVersion ?? "screenshot-frame:1",
    staticProjection: null,
    dynamicProjection: {
      currentStage: projection.currentStage ?? null,
      simultaneousPhase: projection.simultaneousPhase ?? null,
      interactionsByRef,
      seats: {
        [controllingPlayerId]: {
          view: (projection.view ?? null) as RuntimeJson | null,
          availableInteractionRefs,
          zones: zonesByRef,
        },
      },
    },
  });
}

function interactionRefsForFrame(
  availableInteractions: readonly InteractionDescriptor[],
  zones: Readonly<Record<string, ZoneHandlesSnapshot>>,
) {
  const interactionsByRef: Record<string, InteractionDescriptor> = {};
  const refForDescriptor = (descriptor: InteractionDescriptor): string => {
    const ref =
      descriptor.descriptorDigest ??
      `${descriptor.interactionKey}:${descriptor.interactionId}`;
    interactionsByRef[ref] = descriptor;
    return ref;
  };

  return {
    interactionsByRef,
    availableInteractionRefs: availableInteractions.map(refForDescriptor),
    zonesByRef: Object.fromEntries(
      Object.entries(zones).map(([zoneId, zone]) => [
        zoneId,
        {
          cardIds: zone.cardIds,
          cardViewsById: zone.cardViewsById,
          playableByCardId: Object.fromEntries(
            Object.entries(zone.playableByCardId).map(
              ([cardId, descriptors]) => [
                cardId,
                descriptors.map(refForDescriptor),
              ],
            ),
          ),
        },
      ]),
    ),
  };
}

function viewCurrentPhase(view: unknown): string | null {
  if (!view || typeof view !== "object" || !("currentPhase" in view)) {
    return null;
  }
  const value = (view as { currentPhase?: unknown }).currentPhase;
  return typeof value === "string" && value.length > 0 ? value : null;
}
