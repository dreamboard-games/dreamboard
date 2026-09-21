import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PluginGameplayFrame } from "@dreamboard-games/sdk/plugin-runtime-contract";
import { PluginSessionGateway } from "./plugin-session-gateway.js";
import {
  DREAMBOARD_PLUGIN_PROTOCOL,
  DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
} from "@dreamboard-games/sdk/plugin-runtime-contract";

const originalWindow = (globalThis as { window?: unknown }).window;

function createIframe(contentWindow: MessagePort): HTMLIFrameElement {
  return {
    contentWindow,
    src: "/plugin.html",
    sandbox: {
      length: 0,
      contains: () => false,
    },
  } as unknown as HTMLIFrameElement;
}

function createFrame(
  gameVersion: number,
  playerId = "player-1",
): PluginGameplayFrame {
  return {
    basis: {
      version: gameVersion,
      actionSetVersion: `${gameVersion}:test`,
      perspectivePlayerId: playerId,
    },
    view: null,
    flow: {
      currentPhase: null,
      currentStage: null,
      activePlayers: [],
      simultaneousPhase: null,
    },
    availableInteractions: [],
    guidance: null,
    recentEvents: [],
    zones: {},
  };
}

function pluginEnvelope(payload: Record<string, unknown>, channelId: string) {
  return {
    protocol: DREAMBOARD_PLUGIN_PROTOCOL,
    version: DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
    channelId,
    sequence: 1,
    payload,
  };
}

function commandBasis(playerId = "player-1") {
  return {
    version: 1,
    actionSetVersion: "test-action-set",
    perspectivePlayerId: playerId,
  };
}

function postedPayloads(postedMessages: Array<Record<string, unknown>>) {
  return postedMessages
    .map((message) => message.payload)
    .filter((payload): payload is Record<string, unknown> => {
      return typeof payload === "object" && payload !== null;
    });
}

async function waitForChannelId(
  postedMessages: Array<Record<string, unknown>>,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const channelId = postedMessages.find(
      (message) => typeof message.channelId === "string",
    )?.channelId;
    if (typeof channelId === "string") {
      return channelId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for plugin channel id");
}

function dispatchPluginMessage(
  source: MessagePort,
  channelId: string,
  payload: Record<string, unknown>,
  origin = "http://localhost:5174",
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      data: pluginEnvelope(payload, channelId),
      source,
    }),
  );
}

async function createReadyGateway(
  postedMessages: Array<Record<string, unknown>>,
) {
  const { port1 } = new MessageChannel();
  Object.assign(port1, {
    postMessage: (message: Record<string, unknown>) => {
      postedMessages.push(message);
    },
  });
  const iframe = createIframe(port1);

  const gateway = new PluginSessionGateway({
    iframe,
    sessionId: "session-1",
    controllablePlayerIds: ["player-1", "player-2"],
    userId: "user-1",
    onReady: () => {},
    onError: () => {},
    onInteraction: () => {},
  });

  gateway.connect();
  const channelId = await waitForChannelId(postedMessages);

  dispatchPluginMessage(port1, channelId, { type: "runtime.ready" });

  return { gateway, port1, channelId };
}

describe("PluginSessionGateway", () => {
  beforeEach(() => {
    const fakeWindow = new EventTarget() as EventTarget & {
      location: { href: string };
    };
    fakeWindow.location = {
      href: "http://localhost:5174/index.html",
    };
    (globalThis as { window?: unknown }).window = fakeWindow;
  });

  afterEach(() => {
    const globalWithWindow = globalThis as { window?: unknown };
    if (originalWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = originalWindow;
    }
  });

  test("sends the first gameplay frame even when gameVersion is 0", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { port1 } = new MessageChannel();
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const gateway = new PluginSessionGateway({
      iframe,
      sessionId: "session-1",
      controllablePlayerIds: ["player-1"],
      userId: "user-1",
      onReady: () => {},
      onError: () => {},
      onInteraction: () => {},
    });

    gateway.connect();
    const channelId = await waitForChannelId(postedMessages);

    dispatchPluginMessage(port1, channelId, { type: "runtime.ready" });

    gateway.attachStore({
      getGameplayFrame: () => createFrame(0),
      subscribe: () => () => {},
      onStateAck: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const frameMessages = postedPayloads(postedMessages).filter(
      (message) => message.type === "gameplay.frame",
    );

    expect(frameMessages).toHaveLength(1);
    expect(
      (frameMessages[0]?.frame as PluginGameplayFrame | undefined)?.basis
        .version,
    ).toBe(0);

    gateway.disconnect();
  });

  test("sends gameplay frame when controlling player changes without a new gameVersion", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { gateway } = await createReadyGateway(postedMessages);
    let onStoreChange: (() => void) | null = null;
    let currentFrame = createFrame(7, "player-1");

    gateway.attachStore({
      getGameplayFrame: () => currentFrame,
      subscribe: (callback) => {
        onStoreChange = callback;
        return () => {};
      },
      onStateAck: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    currentFrame = createFrame(7, "player-2");
    (onStoreChange as (() => void) | null)?.();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const frameMessages = postedPayloads(postedMessages).filter(
      (message) => message.type === "gameplay.frame",
    );

    expect(frameMessages).toHaveLength(2);
    expect(
      (frameMessages[0]?.frame as PluginGameplayFrame | undefined)?.basis
        .version,
    ).toBe(7);
    expect(
      (frameMessages[0]?.frame as PluginGameplayFrame | undefined)?.basis
        .perspectivePlayerId,
    ).toBe("player-1");
    expect(
      (frameMessages[1]?.frame as PluginGameplayFrame | undefined)?.basis
        .version,
    ).toBe(7);
    expect(
      (frameMessages[1]?.frame as PluginGameplayFrame | undefined)?.basis
        .perspectivePlayerId,
    ).toBe("player-2");

    gateway.disconnect();
  });

  test("correlates runtime acknowledgements with the complete sent basis", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { gateway, port1, channelId } =
      await createReadyGateway(postedMessages);
    let onStoreChange: (() => void) | null = null;
    let currentFrame = createFrame(7, "player-1");
    const acknowledgements: Array<PluginGameplayFrame["basis"]> = [];

    gateway.attachStore({
      getGameplayFrame: () => currentFrame,
      subscribe: (callback) => {
        onStoreChange = callback;
        return () => {};
      },
      onStateAck: (_version, basis) => {
        if (basis) acknowledgements.push(basis);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    currentFrame = createFrame(8, "player-1");
    (onStoreChange as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frameMessages = postedMessages.filter(
      (message) =>
        (message.payload as Record<string, unknown> | undefined)?.type ===
        "gameplay.frame",
    );
    expect(frameMessages).toHaveLength(2);
    for (const message of frameMessages) {
      dispatchPluginMessage(port1, channelId, {
        type: "runtime.ack",
        sequence: message.sequence,
      });
    }

    expect(acknowledgements.map((basis) => basis.version)).toEqual([7, 8]);
    gateway.disconnect();
  });

  test("retries init until the plugin acknowledges ready", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { port1 } = new MessageChannel();
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const gateway = new PluginSessionGateway({
      iframe,
      sessionId: "session-1",
      controllablePlayerIds: ["player-1"],
      userId: "user-1",
      onReady: () => {},
      onError: () => {},
      onInteraction: () => {},
    });

    gateway.connect();

    await new Promise((resolve) => setTimeout(resolve, 325));

    const initMessages = postedPayloads(postedMessages).filter(
      (message) => message.type === "runtime.init",
    );

    expect(initMessages.length).toBeGreaterThanOrEqual(2);

    gateway.disconnect();
  });

  test("logs async interaction handler failures instead of dropping them", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { port1 } = new MessageChannel();
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);
    const logger = {
      log: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };

    const gateway = new PluginSessionGateway({
      iframe,
      sessionId: "session-1",
      controllablePlayerIds: ["player-1"],
      userId: "user-1",
      onReady: () => {},
      onError: () => {},
      onInteraction: async () => {
        throw new Error("submit failed");
      },
      logger,
    });

    gateway.connect();
    const channelId = await waitForChannelId(postedMessages);

    dispatchPluginMessage(port1, channelId, {
      type: "interaction.submit",
      clientActionId: "submit-1",
      basis: commandBasis(),
      interactionId: "takeTurn",
      params: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.error).toHaveBeenCalledWith(
      "[Gateway] Interaction submission error:",
      expect.any(Error),
    );
    expect(postedPayloads(postedMessages)).toContainEqual({
      type: "interaction.result",
      clientActionId: "submit-1",
      accepted: false,
      errorCode: "submission-error",
      message: "submit failed",
    });

    gateway.disconnect();
  });

  test("promotes plugin error messages to the host error callback", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { port1 } = new MessageChannel();
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);
    const onError = mock((_: Error) => undefined);
    const logger = {
      log: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };

    const gateway = new PluginSessionGateway({
      iframe,
      sessionId: "session-1",
      controllablePlayerIds: ["player-1"],
      userId: "user-1",
      expectedSdkVersion: "0.4.0-alpha.host",
      onReady: () => {},
      onError,
      onInteraction: () => {},
      logger,
    });

    gateway.connect();
    const channelId = await waitForChannelId(postedMessages);
    const initCountBeforeError = postedPayloads(postedMessages).filter(
      (message) => message.type === "runtime.init",
    ).length;

    dispatchPluginMessage(port1, channelId, {
      type: "runtime.error",
      message: "useRuntimeContext must be used within a provider",
      code: "UNCAUGHT_ERROR",
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0].name).toBe("PluginRuntimeError");
    expect(onError.mock.calls[0]?.[0].message).toContain("UNCAUGHT_ERROR");
    expect(onError.mock.calls[0]?.[0].message).toContain(
      "Host expected @dreamboard-games/sdk version: 0.4.0-alpha.host",
    );
    expect(gateway.getState()).toBe("error");

    await new Promise((resolve) => setTimeout(resolve, 325));
    expect(
      postedPayloads(postedMessages).filter(
        (message) => message.type === "runtime.init",
      ),
    ).toHaveLength(initCountBeforeError);

    gateway.disconnect();
  });

  test("keeps the plugin connected after a submission timeout report", async () => {
    const postedMessages: Array<Record<string, unknown>> = [];
    const { port1 } = new MessageChannel();
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);
    const onError = mock((_: Error) => undefined);
    const logger = {
      log: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    };

    const gateway = new PluginSessionGateway({
      iframe,
      sessionId: "session-1",
      controllablePlayerIds: ["player-1"],
      userId: "user-1",
      onReady: () => {},
      onError,
      onInteraction: () => {},
      logger,
    });

    gateway.connect();
    const channelId = await waitForChannelId(postedMessages);
    dispatchPluginMessage(port1, channelId, { type: "runtime.ready" });

    dispatchPluginMessage(port1, channelId, {
      type: "runtime.error",
      message:
        "Submission request timed out\nSubmissionError: Submission request timed out",
      code: "UNHANDLED_REJECTION",
    });

    expect(onError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Gateway] Recoverable plugin submission timeout ignored.",
    );
    expect(gateway.getState()).toBe("connected");

    gateway.disconnect();
  });
});
