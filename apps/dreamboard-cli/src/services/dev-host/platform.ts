import { createUserSessionManager } from "../../auth/user-session-manager.js";
import { resolveLocalHarnessAccessToken } from "../../config/local-harness-auth.js";
import type { ResolvedConfig } from "../../types.js";
import type { DevHostPlatform, DevHostResolvedBearer } from "./contract.js";

export function createCliDevHostPlatform(
  config: ResolvedConfig,
): DevHostPlatform {
  return {
    resolveBearer: () => resolveDevHostBearer(config),
  };
}

export async function resolveDevHostBearer(
  config: ResolvedConfig,
): Promise<DevHostResolvedBearer> {
  const localHarnessToken = resolveLocalHarnessAccessToken(config);
  if (localHarnessToken) {
    return { kind: "ok", token: localHarnessToken };
  }

  if (config.refreshTokenSource !== "global") {
    return { kind: "ok", token: config.authToken ?? null };
  }

  if (!config.refreshToken) {
    return {
      kind: "permanent_invalid",
      message:
        "Stored Dreamboard session is expired or invalid. Run `dreamboard auth login` to authenticate again.",
    };
  }

  const resolved = await createUserSessionManager(config).resolveApiToken();
  return { kind: "ok", token: resolved?.token ?? null };
}
