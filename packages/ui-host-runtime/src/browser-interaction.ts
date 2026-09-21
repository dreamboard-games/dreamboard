import {
  createBrowserInteractionActuatorAttributes,
  createBrowserInteractionRootAttributes,
  defineBrowserInteractionSurface,
  DREAMBOARD_BROWSER_INTERACTION_PROTOCOL_VERSION,
  type BrowserInteractionAttributeMap,
} from "@dreamboard-games/sdk/browser-interaction";

export const HOST_BROWSER_INTERACTION_SURFACE = "host" as const;
export const HOST_BROWSER_INTERACTION_SCOPE = "session" as const;
export const HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY =
  "host.switchControlledPlayer" as const;
export const HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_ID =
  "switchControlledPlayer" as const;
export const HOST_SWITCH_CONTROLLED_PLAYER_INTENT =
  "switchControlledPlayer" as const;
export const HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND =
  "switchControlledPlayer" as const;

export const hostBrowserInteractionSurface = defineBrowserInteractionSurface({
  surface: HOST_BROWSER_INTERACTION_SURFACE,
  intents: [HOST_SWITCH_CONTROLLED_PLAYER_INTENT],
  effectKinds: [HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND],
} as Parameters<typeof defineBrowserInteractionSurface>[0] & {
  readonly effectKinds: readonly string[];
});

export function createHostSwitchControlledPlayerRootAttributes(): BrowserInteractionAttributeMap {
  return {
    ...createBrowserInteractionRootAttributes({
      surface: HOST_BROWSER_INTERACTION_SURFACE,
      scopeId: HOST_BROWSER_INTERACTION_SCOPE,
      interactionKey: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY,
      interactionId: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_ID,
      readiness: "ready",
    }),
    [PROTOCOL_ATTRIBUTE]: DREAMBOARD_BROWSER_INTERACTION_PROTOCOL_VERSION,
  };
}

export function createHostSwitchControlledPlayerActuatorAttributes(input: {
  readonly playerId: string;
  readonly selected: boolean;
  readonly enabled: boolean;
}): BrowserInteractionAttributeMap {
  return {
    ...createBrowserInteractionActuatorAttributes({
      surface: HOST_BROWSER_INTERACTION_SURFACE,
      scopeId: HOST_BROWSER_INTERACTION_SCOPE,
      interactionKey: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY,
      interactionId: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_ID,
      intent: HOST_SWITCH_CONTROLLED_PLAYER_INTENT,
      inputKey: "playerId",
      candidateValue: input.playerId,
      candidateState: input.selected ? "selected" : "unselected",
      enabled: input.enabled,
      actuatorKind: "click",
    }),
    [PROTOCOL_ATTRIBUTE]: DREAMBOARD_BROWSER_INTERACTION_PROTOCOL_VERSION,
    [SEMANTIC_EFFECTS_ATTRIBUTE]: encodeBrowserEffectList([
      {
        kind: HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND,
        playerId: input.playerId,
        beforeSelected: input.selected,
        afterSelected: true,
      },
    ]),
  };
}

export function createHostSwitchControlledPlayerMenuTriggerAttributes(): BrowserInteractionAttributeMap {
  return {
    ...createBrowserInteractionActuatorAttributes({
      surface: HOST_BROWSER_INTERACTION_SURFACE,
      scopeId: HOST_BROWSER_INTERACTION_SCOPE,
      interactionKey: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_KEY,
      interactionId: HOST_SWITCH_CONTROLLED_PLAYER_INTERACTION_ID,
      intent: HOST_SWITCH_CONTROLLED_PLAYER_INTENT,
      actuatorKind: "click",
      prepares: {
        intent: HOST_SWITCH_CONTROLLED_PLAYER_INTENT,
        inputKey: "playerId",
        actuatorKind: "click",
      },
    }),
    [PROTOCOL_ATTRIBUTE]: DREAMBOARD_BROWSER_INTERACTION_PROTOCOL_VERSION,
    [PREPARATION_PATTERNS_ATTRIBUTE]: encodeBrowserEffectPatternList([
      {
        kind: "match",
        effectKind: HOST_SWITCH_CONTROLLED_PLAYER_EFFECT_KIND,
        fields: {},
      },
    ]),
  };
}

const PROTOCOL_ATTRIBUTE = "data-dreamboard-browser-protocol";
const SEMANTIC_EFFECTS_ATTRIBUTE = "data-dreamboard-semantic-effects";
const PREPARATION_PATTERNS_ATTRIBUTE = "data-dreamboard-preparation-patterns";

type CanonicalBrowserValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalBrowserValue[]
  | { readonly [key: string]: CanonicalBrowserValue };

function encodeBrowserEffectList(
  effects: ReadonlyArray<{ readonly [key: string]: CanonicalBrowserValue }>,
): string {
  return JSON.stringify(effects.map(encodeCanonicalBrowserValue));
}

function encodeBrowserEffectPatternList(
  patterns: ReadonlyArray<{ readonly [key: string]: CanonicalBrowserValue }>,
): string {
  return JSON.stringify(patterns.map(encodeCanonicalBrowserValue));
}

function encodeCanonicalBrowserValue(value: CanonicalBrowserValue): string {
  return JSON.stringify(canonicalizeBrowserValue(value));
}

function canonicalizeBrowserValue(
  value: CanonicalBrowserValue,
): CanonicalBrowserValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeBrowserValue);
  }
  if (value && typeof value === "object") {
    const record = value as { readonly [key: string]: CanonicalBrowserValue };
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, recordValue]) => [
          key,
          canonicalizeBrowserValue(recordValue),
        ]),
    );
  }
  return value;
}
