import {
  ClientGameplayFrameSchema,
  type ClientGameplayFrame,
} from "@dreamboard-games/gameplay-authority-protocol";

/**
 * Encodes an outbound client frame, validating it against the shared protocol
 * schema before serialization. Mirrors the server's `encodeServerGameplayFrame`
 * so the client cannot silently send a frame that has drifted from the
 * contract (the server validates the same frames with
 * `ClientGameplayFrameSchema.parse` on receipt).
 */
export function encodeClientGameplayFrame(frame: ClientGameplayFrame): string {
  return JSON.stringify(ClientGameplayFrameSchema.parse(frame));
}
