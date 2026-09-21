import { randomUUID } from "node:crypto";
import { getSessionSnapshot } from "@dreamboard-games/api-client";
import { client as apiClient } from "@dreamboard-games/api-client/client.gen";
import { connectGameplayAuthority } from "@dreamboard-games/gameplay-authority-client";
import type {
  InteractionResult,
  SubmitInteractionCommand,
} from "@dreamboard-games/sdk/plugin-runtime-contract";

export type SubmitGameplayAuthorityActionOptions = {
  path: { sessionId: string; playerId: string; interactionId: string };
  body: {
    expectedVersion: number;
    actionSetVersion: string;
    inputs: SubmitInteractionCommand["params"];
  };
  headers?: Record<string, string>;
  connectAuthority?: typeof connectGameplayAuthority;
  clientActionIdFactory?: () => string;
};

export type SubmitGameplayAuthorityActionResult = {
  data?: InteractionResult;
  error?: unknown;
};

export async function submitGameplayAuthorityAction(
  options: SubmitGameplayAuthorityActionOptions,
): Promise<SubmitGameplayAuthorityActionResult> {
  try {
    const snapshot = await getSessionSnapshot({
      path: { sessionId: options.path.sessionId },
    });
    if (snapshot.error || !snapshot.data)
      return {
        error: snapshot.error ?? new Error("Session snapshot unavailable."),
      };

    const connection = await (
      options.connectAuthority ?? connectGameplayAuthority
    )({
      websocketUrl: snapshot.data.context.gameplayWebsocketUrl,
      credential: currentGameplayCredential(),
      sessionId: options.path.sessionId,
      playerId: options.path.playerId,
      openTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
    });
    try {
      return {
        data: await connection.submit({
          type: "interaction.submit",
          clientActionId:
            options.headers?.["X-Dreamboard-Client-Action-Id"] ??
            options.clientActionIdFactory?.() ??
            randomUUID(),
          basis: {
            version: options.body.expectedVersion,
            actionSetVersion: options.body.actionSetVersion,
            perspectivePlayerId: options.path.playerId,
          },
          interactionId: options.path.interactionId,
          params: options.body.inputs,
        }),
      };
    } finally {
      connection.close();
    }
  } catch (error) {
    return { error };
  }
}

export function currentGameplayCredential(): { kind: "user"; token: string } {
  const authorization = new Headers(
    apiClient.getConfig().headers as HeadersInit,
  ).get("Authorization");
  if (!authorization?.startsWith("Bearer "))
    throw new Error(
      "Authenticate with dreamboard login before using gameplay.",
    );
  return { kind: "user", token: authorization.slice("Bearer ".length) };
}
