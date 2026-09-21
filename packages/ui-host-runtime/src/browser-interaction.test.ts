import { describe, expect, test } from "bun:test";
import {
  createBrowserInteractionRegistry,
  createGameplayActuatorAttributes,
  createGameplayInteractionRootAttributes,
  gameplayBrowserInteractionSurface,
  normalizeBrowserInteractionRecords,
  resolveBrowserInteractionEffect,
  type BrowserInteractionRawRecord,
  type BrowserInteractionSurfaceEffect,
  type GameplaySemanticEffect,
} from "@dreamboard-games/sdk/browser-interaction";
import {
  createHostSwitchControlledPlayerActuatorAttributes,
  createHostSwitchControlledPlayerMenuTriggerAttributes,
  createHostSwitchControlledPlayerRootAttributes,
  hostBrowserInteractionSurface,
  HOST_BROWSER_INTERACTION_SCOPE,
  HOST_BROWSER_INTERACTION_SURFACE,
  HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND,
  HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY,
} from "./browser-interaction.js";

function record(
  attributes: Record<string, string | boolean>,
): BrowserInteractionRawRecord {
  return { attributes };
}

describe("host browser interaction surface", () => {
  test("agent-style consumer resolves gameplay, preparation-required and host effects", async () => {
    const registry = createBrowserInteractionRegistry([
      gameplayBrowserInteractionSurface,
      hostBrowserInteractionSurface,
    ]);
    const gameplayRoot = createGameplayInteractionRootAttributes({
      scopeId: "runtime",
      interactionKey: "playerTurn.offerTrade",
      interactionId: "offerTrade",
      descriptorDigest: "sha256:descriptor",
      draftDigest: "sha256:draft",
      readiness: "ready",
    });
    const exactGameplayEffect: GameplaySemanticEffect = {
      kind: "setCandidate",
      inputKey: "targetPlayerIds",
      candidateValue: "player-2",
      beforeSelected: false,
      afterSelected: true,
    };
    const preparationGameplayEffect: BrowserInteractionSurfaceEffect = {
      kind: "setCandidate",
      inputKey: "route",
      candidateValue: "north",
      beforeSelected: false,
      afterSelected: true,
    };
    const hostEffect: BrowserInteractionSurfaceEffect = {
      kind: HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND,
      playerId: "player-2",
      beforeSelected: false,
      afterSelected: true,
    };

    const snapshot = normalizeBrowserInteractionRecords(
      [
        record(gameplayRoot),
        record(
          createGameplayActuatorAttributes({
            scopeId: "runtime",
            interactionKey: "playerTurn.offerTrade",
            interactionId: "offerTrade",
            descriptorDigest: "sha256:descriptor",
            draftDigest: "sha256:draft",
            intent: "toggle",
            inputKey: "targetPlayerIds",
            candidateValue: "player-2",
            candidateState: "unselected",
            enabled: true,
            actuatorKind: "click",
            semanticEffects: [exactGameplayEffect],
          }),
        ),
        record(
          createGameplayActuatorAttributes({
            scopeId: "runtime",
            interactionKey: "playerTurn.offerTrade",
            interactionId: "offerTrade",
            descriptorDigest: "sha256:descriptor",
            draftDigest: "sha256:draft",
            intent: "reveal",
            inputKey: "route",
            enabled: true,
            actuatorKind: "click",
            preparationPatterns: [
              {
                kind: "match",
                effectKind: "setCandidate",
                fields: { inputKey: "route" },
              },
            ],
          }),
        ),
        record(createHostSwitchControlledPlayerRootAttributes()),
        record(createHostSwitchControlledPlayerMenuTriggerAttributes()),
        record(
          createHostSwitchControlledPlayerActuatorAttributes({
            playerId: "player-2",
            selected: false,
            enabled: true,
          }),
        ),
      ],
      { registry },
    );

    const exactGameplayResolution = resolveBrowserInteractionEffect(snapshot, {
      surface: "gameplay",
      scopeId: "runtime",
      interactionKey: "playerTurn.offerTrade",
      effect: exactGameplayEffect,
    });
    const preparationResolution = resolveBrowserInteractionEffect(snapshot, {
      surface: "gameplay",
      scopeId: "runtime",
      interactionKey: "playerTurn.offerTrade",
      effect: preparationGameplayEffect,
    });
    const hostResolution = resolveBrowserInteractionEffect(snapshot, {
      surface: HOST_BROWSER_INTERACTION_SURFACE,
      scopeId: HOST_BROWSER_INTERACTION_SCOPE,
      interactionKey: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY,
      effect: hostEffect,
    });
    const unavailableResolution = resolveBrowserInteractionEffect(snapshot, {
      surface: "gameplay",
      scopeId: "runtime",
      interactionKey: "playerTurn.offerTrade",
      effect: {
        kind: "setCandidate",
        inputKey: "targetPlayerIds",
        candidateValue: "player-9",
        beforeSelected: false,
        afterSelected: true,
      },
    });

    const packageJson = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as { dependencies?: Record<string, string>; version?: string };
    const proof = {
      sdkPackage:
        packageJson.dependencies?.["@dreamboard-games/sdk"] ?? "unknown",
      privateCandidateRevision: packageJson.version ?? "unknown",
      available: snapshot.surfaces.flatMap((surface) =>
        "interactions" in surface
          ? (surface.interactions ?? []).flatMap((interaction) =>
              interaction.actuators.map((actuator) => ({
                surface: surface.surface,
                scopeId: surface.scopeId,
                interactionKey: interaction.interactionKey,
                intent: actuator.intent,
                semanticEffects: actuator.semanticEffects,
                preparationPatterns: actuator.preparationPatterns,
              })),
            )
          : [],
      ),
      resolutions: {
        exactGameplay: exactGameplayResolution,
        preparationRequired: preparationResolution,
        host: hostResolution,
        unavailable: unavailableResolution,
      },
    };

    expect(exactGameplayResolution).toMatchObject({
      ok: true,
      match: "exact",
    });
    expect(preparationResolution).toMatchObject({
      ok: false,
      code: "preparation-required",
    });
    expect(hostResolution).toMatchObject({ ok: true, match: "exact" });
    expect(unavailableResolution).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(JSON.parse(JSON.stringify(proof))).toMatchObject({
      resolutions: {
        exactGameplay: { ok: true },
        preparationRequired: { ok: false, code: "preparation-required" },
        host: { ok: true },
        unavailable: { ok: false, code: "not-found" },
      },
    });
  });
});
