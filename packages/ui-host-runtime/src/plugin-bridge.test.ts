import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PluginBridge } from "./plugin-bridge.js";
import {
  DREAMBOARD_PLUGIN_PROTOCOL,
  DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { PluginGameplayFrame } from "@dreamboard-games/sdk/plugin-runtime-contract";

const originalWindow = (globalThis as { window?: unknown }).window;

function createIframe(
  contentWindow: MessagePort,
  options: { src?: string; sandboxTokens?: string[] } = {},
): HTMLIFrameElement {
  return {
    contentWindow,
    src: options.src ?? "/plugin.html",
    sandbox: {
      length: options.sandboxTokens?.length ?? 0,
      contains: (token: string) =>
        options.sandboxTokens?.includes(token) ?? false,
    },
  } as unknown as HTMLIFrameElement;
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

describe("PluginBridge", () => {
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

  test("accepts ready messages from a same-origin dev iframe", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });
    const channelId = postedMessages[0]?.channelId;
    expect(typeof channelId).toBe("string");

    let ready = false;
    bridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:5174",
        data: pluginEnvelope({ type: "runtime.ready" }, channelId as string),
        source: port1,
      }),
    );

    expect(ready).toBe(true);
    bridge.disconnect();
  });

  test("still accepts ready messages from a sandboxed null-origin iframe", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1, {
      src: "blob:http://localhost:5174/plugin",
      sandboxTokens: ["allow-scripts"],
    });

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });
    const channelId = postedMessages[0]?.channelId;
    expect(typeof channelId).toBe("string");

    let ready = false;
    bridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        data: pluginEnvelope({ type: "runtime.ready" }, channelId as string),
        source: port1,
      }),
    );

    expect(ready).toBe(true);
    bridge.disconnect();
  });

  test("ignores matching-origin messages from a different source window", () => {
    const { port1 } = new MessageChannel();
    const { port1: otherPort } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });
    const channelId = postedMessages[0]?.channelId;
    expect(typeof channelId).toBe("string");

    let ready = false;
    bridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:5174",
        data: pluginEnvelope({ type: "runtime.ready" }, channelId as string),
        source: otherPort,
      }),
    );

    expect(ready).toBe(false);
    bridge.disconnect();
  });

  test("ignores same-window messages from the wrong origin", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });
    const channelId = postedMessages[0]?.channelId;
    expect(typeof channelId).toBe("string");

    let ready = false;
    bridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://evil.example",
        data: pluginEnvelope({ type: "runtime.ready" }, channelId as string),
        source: port1,
      }),
    );

    expect(ready).toBe(false);
    bridge.disconnect();
  });

  test("ignores same-window messages on the wrong channel", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });

    let ready = false;
    bridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:5174",
        data: pluginEnvelope(
          { type: "runtime.ready" },
          "wrong-channel-id-0000000000000000000000000000",
        ),
        source: port1,
      }),
    );

    expect(ready).toBe(false);
    bridge.disconnect();
  });

  test("ignores stale channel messages after teardown and reconnect", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const firstBridge = new PluginBridge(iframe);
    firstBridge.sendInit({ sessionId: "session-1", players: [] });
    const staleChannelId = postedMessages[0]?.channelId;
    expect(typeof staleChannelId).toBe("string");
    firstBridge.disconnect();

    const secondBridge = new PluginBridge(iframe);
    let ready = false;
    secondBridge.onPluginMessage("runtime.ready", () => {
      ready = true;
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:5174",
        data: pluginEnvelope(
          { type: "runtime.ready" },
          staleChannelId as string,
        ),
        source: port1,
      }),
    );

    expect(ready).toBe(false);
    secondBridge.disconnect();
  });

  test("sends host messages to the exact iframe origin", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<{
      message: Record<string, unknown>;
      targetOrigin: string;
    }> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
        postedMessages.push({ message, targetOrigin });
      },
    });
    const iframe = createIframe(port1, {
      src: "http://plugin.example/plugin.html",
    });

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });

    expect(postedMessages[0]?.targetOrigin).toBe("http://plugin.example");
    expect(postedMessages[0]?.message).toMatchObject({
      protocol: DREAMBOARD_PLUGIN_PROTOCOL,
      version: DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
      payload: { type: "runtime.init" },
    });
    bridge.disconnect();
  });

  test("uses wildcard target only for opaque iframe origins with an envelope", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<{
      message: Record<string, unknown>;
      targetOrigin: string;
    }> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>, targetOrigin: string) => {
        postedMessages.push({ message, targetOrigin });
      },
    });
    const iframe = createIframe(port1, {
      src: "blob:http://localhost:5174/plugin",
      sandboxTokens: ["allow-scripts"],
    });

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });

    expect(postedMessages[0]?.targetOrigin).toBe("*");
    expect(postedMessages[0]?.message).toMatchObject({
      protocol: DREAMBOARD_PLUGIN_PROTOCOL,
      version: DREAMBOARD_PLUGIN_PROTOCOL_VERSION,
      payload: { type: "runtime.init" },
    });
    bridge.disconnect();
  });

  test("sends canonical gameplay frames without a shared-view bridge", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);
    const frame: PluginGameplayFrame = {
      basis: {
        version: 1,
        actionSetVersion: "actions-1",
        perspectivePlayerId: "player-1",
      },
      view: null,
      flow: {
        currentPhase: null,
        currentStage: null,
        activePlayers: ["player-1"],
        simultaneousPhase: null,
      },
      availableInteractions: [],
      recentEvents: [],
      zones: {},
    };

    const bridge = new PluginBridge(iframe);
    bridge.sendGameplayFrame(frame);

    expect(postedMessages[0]).toMatchObject({
      payload: {
        type: "gameplay.frame",
        frame: {
          basis: {
            version: 1,
            actionSetVersion: "actions-1",
            perspectivePlayerId: "player-1",
          },
        },
      },
    });
    expect(postedMessages[0]).not.toHaveProperty("payload.frame.sharedView");
    expect(frame).not.toHaveProperty("sharedView");
    bridge.disconnect();
  });

  test("does not add shared view to other outgoing messages", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);

    const bridge = new PluginBridge(iframe);
    bridge.sendInit({ sessionId: "session-1", players: [] });

    expect(postedMessages[0]).not.toHaveProperty("payload.sharedView");
    expect(postedMessages[0]).not.toHaveProperty("payload.session.sharedView");
    bridge.disconnect();
  });

  test("still rejects invalid internal gameplay frames before bridging", () => {
    const { port1 } = new MessageChannel();
    const postedMessages: Array<Record<string, unknown>> = [];
    Object.assign(port1, {
      postMessage: (message: Record<string, unknown>) => {
        postedMessages.push(message);
      },
    });
    const iframe = createIframe(port1);
    const bridge = new PluginBridge(iframe, "*", {
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const sequence = bridge.send({
      type: "gameplay.frame",
      frame: { basis: { version: -1 } },
    } as unknown as Parameters<PluginBridge["send"]>[0]);

    expect(sequence).toBeNull();
    expect(postedMessages).toHaveLength(0);
    bridge.disconnect();
  });
});
