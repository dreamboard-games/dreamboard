import { randomUUID } from "node:crypto";
import { createGameplayCapability } from "@dreamboard-games/api-client";
import {
  GameplayAuthorityRecoveringError,
  connectGameplayAuthority,
} from "@dreamboard-games/gameplay-authority-client";

const CLIENT_ACTION_ID_HEADER = "X-Dreamboard-Client-Action-Id";
const DEFAULT_TIMEOUT_MS = 10_000;

export type SubmitGameplayAuthorityActionOptions = {
  path: {
    sessionId: string;
    playerId: string;
    interactionId: string;
  };
  body: {
    expectedVersion: number;
    actionSetVersion: string;
    inputs: Record<string, unknown>;
  };
  headers?: Record<string, string>;
  capabilityRequester?: typeof createGameplayCapability;
  connectAuthority?: typeof connectGameplayAuthority;
  clientActionIdFactory?: () => string;
};

export type GameplayAuthorityActionSubmitResponse = {
  success: boolean;
  version: number;
  actionSetVersion: string;
  accepted?: boolean | null;
  durabilityStatus?: "COMMITTED" | null;
  errorCode?: string | null;
  message?: string | null;
  clientActionId?: string | null;
};

export type SubmitGameplayAuthorityActionResult = {
  data?: GameplayAuthorityActionSubmitResponse;
  error?: unknown;
  response?: Response;
};

export async function submitGameplayAuthorityAction(
  options: SubmitGameplayAuthorityActionOptions,
): Promise<SubmitGameplayAuthorityActionResult> {
  try {
    const requestCapability =
      options.capabilityRequester ?? createGameplayCapability;
    const connectAuthority =
      options.connectAuthority ?? connectGameplayAuthority;
    const capability = await requestCapability({
      path: {
        sessionId: options.path.sessionId,
        playerId: options.path.playerId,
      },
    });
    if (capability.error || !capability.data) {
      return { error: capability.error ?? new Error("Missing capability.") };
    }

    const clientActionId =
      options.headers?.[CLIENT_ACTION_ID_HEADER] ??
      options.clientActionIdFactory?.() ??
      randomUUID();
    const client = await connectAuthority({
      websocketUrl: capability.data.websocketUrl,
      capabilityToken: capability.data.token,
      openTimeoutMs: DEFAULT_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_TIMEOUT_MS,
    });

    try {
      const frame = await client.submitCommand({
        clientActionId,
        expectedVersion: options.body.expectedVersion,
        actionSetVersion: options.body.actionSetVersion,
        interactionId: options.path.interactionId,
        inputs: options.body.inputs ?? {},
      });
      if (frame.type === "command.rejected") {
        return {
          data: {
            success: false,
            accepted: false,
            version:
              typeof frame.currentVersion === "number"
                ? frame.currentVersion
                : options.body.expectedVersion,
            actionSetVersion: options.body.actionSetVersion,
            errorCode:
              typeof frame.errorCode === "string" ? frame.errorCode : undefined,
            message:
              typeof frame.message === "string" ? frame.message : undefined,
            clientActionId,
          },
        };
      }
      const acceptedVersion =
        typeof frame.version === "number" ? frame.version : undefined;
      if (acceptedVersion === undefined) {
        return {
          error: new Error("Accepted frame did not include a numeric version."),
        };
      }
      const update =
        frame.update && typeof frame.update === "object"
          ? (frame.update as Record<string, unknown>)
          : {};
      const view =
        update.view && typeof update.view === "object"
          ? (update.view as { actionSetVersion?: unknown })
          : {};
      const projectedActionSetVersion =
        typeof view.actionSetVersion === "string"
          ? view.actionSetVersion
          : undefined;
      return {
        data: {
          success: true,
          accepted: true,
          durabilityStatus: "COMMITTED",
          version: acceptedVersion,
          actionSetVersion:
            projectedActionSetVersion ?? options.body.actionSetVersion,
          clientActionId,
        },
      };
    } catch (error) {
      if (error instanceof GameplayAuthorityRecoveringError) {
        return {
          error: new Error(error.message || "Session authority is recovering."),
        };
      }
      throw error;
    } finally {
      client.close();
    }
  } catch (error) {
    return { error };
  }
}
