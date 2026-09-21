import type {
  SeatAssignment,
  SessionActor,
  SessionGameSource,
} from "@dreamboard-games/api-client";

type HexColor = string & { readonly __brand: "HexColor" };

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function parseHexColor(value: unknown): HexColor | undefined {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? (value as HexColor)
    : undefined;
}

/** Stable string principal for comparing actors to connection `userId` / demo actor id. */
export function principalKey(actor: SessionActor): string {
  if (actor.kind === "AUTH_USER") {
    return actor.id;
  }
  return actor.demoActorSessionId;
}

export function principalMatchesActor(
  principalId: string | null | undefined,
  actor: SessionActor,
): boolean {
  if (!principalId) {
    return false;
  }
  return principalKey(actor) === principalId;
}

export function seatControlledByPrincipal(
  seat: SeatAssignment,
  principalId: string | null | undefined,
): boolean {
  if (!principalId || !seat.controllerActor) {
    return false;
  }
  return principalMatchesActor(principalId, seat.controllerActor);
}

export function projectIdFromGameSource(source: SessionGameSource): string {
  if (source.kind === "USER_COMPILED") {
    return source.projectId;
  }
  return `demo:${source.slug}:${source.revisionId}`;
}

export function seatsForPluginSnapshot(seats: SeatAssignment[]): Array<{
  playerId: string;
  controllerUserId?: string;
  displayName: string;
  playerColor?: HexColor;
  isHost?: boolean;
}> {
  return seats.map((seat) => ({
    playerId: seat.playerId,
    controllerUserId: seat.controllerActor
      ? principalKey(seat.controllerActor)
      : undefined,
    displayName: seat.displayName,
    playerColor: parseHexColor(seat.playerColor),
    isHost: seat.isHost,
  }));
}
