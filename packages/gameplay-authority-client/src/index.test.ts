import { describe, expect, test } from "vitest";
import {
  GameplayAuthorityBackpressureError,
  connectGameplayAuthority,
  type GameplayAuthorityWebSocketInit,
  type GameplayAuthorityWebSocketLike,
} from "./index.js";

const WEBSOCKET_URL = "wss://authority.test/gameplay";
const CREDENTIAL = { kind: "user", token: "user-token" } as const;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PLAYER_ID = "player-1";
const EXPIRES_AT = "2026-06-02T00:00:00.000Z";
const SNAPSHOT_FRAME = {
  type: "session.snapshot",
  boardStatic: null,
  frame: {
    basis: {
      version: 4,
      actionSetVersion: "sha256:actions",
      perspectivePlayerId: "player-1",
    },
    view: { turn: 4 },
    flow: {
      currentPhase: null,
      currentStage: null,
      activePlayers: [],
      simultaneousPhase: null,
    },
    availableInteractions: [],
    recentEvents: [],
    zones: {},
  },
  history: {
    entries: [
      {
        version: 4,
        timestamp: "2026-06-02T00:00:00.000Z",
        description: "Interaction committed.",
        playerId: "player-1",
        isCurrent: true,
      },
    ],
  },
  lifecycle: { status: "active" },
} as const;

describe("gameplay authority client", () => {
  test("adapts native browser websocket events", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const factory = createFakeBrowserWebSocketFactory();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: factory.ctor,
    });

    try {
      const clientPromise = connectGameplayAuthority({
        websocketUrl: WEBSOCKET_URL,
        credential: CREDENTIAL,
        sessionId: SESSION_ID,
        playerId: PLAYER_ID,
      });

      await flushPromises();
      const socket = expectSingleBrowserSocket(factory);
      socket.emit("open");
      await flushPromises();
      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
        type: "auth.connect",
        credential: CREDENTIAL,
        sessionId: SESSION_ID,
        playerId: PLAYER_ID,
      });
      socket.emitMessage({
        type: "auth.accepted",
        expiresAt: EXPIRES_AT,
      });

      const client = await clientPromise;
      const iterator = client.frames()[Symbol.asyncIterator]();
      const nextFrame = iterator.next();
      socket.emitMessage(SNAPSHOT_FRAME);

      await expect(nextFrame).resolves.toMatchObject({
        done: false,
        value: { type: "session.snapshot", frame: { basis: { version: 4 } } },
      });
      await iterator.return?.();
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  test("authenticates websocket and submits command frames", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await authenticate(factory);
    const client = await clientPromise;
    const socket = expectSingleSocket(factory);
    const submitted = client.submit({
      type: "interaction.submit",
      clientActionId: "client-action-1",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: { cardId: "card-1" },
    });

    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "interaction.submit",
      clientActionId: "client-action-1",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: { cardId: "card-1" },
    });

    socket.emitJson({
      type: "interaction.result",
      clientActionId: "client-action-1",
      accepted: true,
    });

    await expect(submitted).resolves.toMatchObject({
      type: "interaction.result",
      clientActionId: "client-action-1",
      accepted: true,
    });
  });

  test("passes websocket init to custom factories", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
      webSocketInit: {
        headers: { Origin: "http://127.0.0.1:5174" },
      },
    });

    await authenticate(factory);
    const client = await clientPromise;
    const socket = expectSingleSocket(factory);
    expect(socket.init).toEqual({
      headers: { Origin: "http://127.0.0.1:5174" },
    });
    client.close();
  });

  test("rejects custom headers with the default browser factory", async () => {
    await expect(
      connectGameplayAuthority({
        websocketUrl: WEBSOCKET_URL,
        credential: CREDENTIAL,
        sessionId: SESSION_ID,
        playerId: PLAYER_ID,
        webSocketInit: {
          headers: { Origin: "http://127.0.0.1:5174" },
        },
      }),
    ).rejects.toThrow("Browser WebSocket does not support custom headers");
  });

  test("ignores empty websocket init with the default browser factory", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const factory = createFakeBrowserWebSocketFactory();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: factory.ctor,
    });

    try {
      const emptyInitClient = connectGameplayAuthority({
        websocketUrl: WEBSOCKET_URL,
        credential: CREDENTIAL,
        sessionId: SESSION_ID,
        playerId: PLAYER_ID,
        webSocketInit: {},
      });
      await authenticateBrowser(factory);
      (await emptyInitClient).close();

      const emptyHeadersClient = connectGameplayAuthority({
        websocketUrl: WEBSOCKET_URL,
        credential: CREDENTIAL,
        sessionId: SESSION_ID,
        playerId: PLAYER_ID,
        webSocketInit: { headers: {} },
      });
      await authenticateBrowser(factory, 1);
      (await emptyHeadersClient).close();

      expect(factory.instances.map((socket) => socket.init)).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  test("returns command rejection frames", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await authenticate(factory);
    const client = await clientPromise;
    const rejected = client.submit({
      type: "interaction.submit",
      clientActionId: "client-action-rejected",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: {},
    });

    expectSingleSocket(factory).emitJson({
      type: "interaction.result",
      clientActionId: "client-action-rejected",
      accepted: false,
      errorCode: "stale-version",
      message: "Command expected a stale gameplay version.",
    });

    await expect(rejected).resolves.toMatchObject({
      type: "interaction.result",
      clientActionId: "client-action-rejected",
      accepted: false,
      errorCode: "stale-version",
    });
  });

  test("throws typed backpressure error for gameplay.backpressure command frame", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await authenticate(factory);
    const client = await clientPromise;
    const submitted = client.submit({
      type: "interaction.submit",
      clientActionId: "client-action-recovering",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: "player-1",
      },
      interactionId: "play-card",
      params: {},
    });

    expectSingleSocket(factory).emitJson({
      type: "gameplay.backpressure",
      reason: "queue_full",
      retryAfterMs: 750,
      message: "Gameplay authority ownership changed.",
      operation: "interaction.submit",
      clientActionId: "client-action-recovering",
    });

    await expect(submitted).rejects.toBeInstanceOf(
      GameplayAuthorityBackpressureError,
    );
    await expect(submitted).rejects.toMatchObject({
      message: "Gameplay authority ownership changed.",
      reason: "queue_full",
      retryAfterMs: 750,
      operation: "interaction.submit",
      clientActionId: "client-action-recovering",
    });
  });

  test("correlates backpressure to its operation and request while other requests remain pending", async () => {
    const factory = createFakeWebSocketFactory();
    const connecting = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });
    await authenticate(factory);
    const client = await connecting;
    const command = {
      type: "interaction.submit" as const,
      clientActionId: "accepted",
      basis: {
        version: 3,
        actionSetVersion: "3:main",
        perspectivePlayerId: PLAYER_ID,
      },
      interactionId: "play-card",
      params: {},
    };
    const accepted = client.submit(command);
    const rejected = client.submit({ ...command, clientActionId: "rejected" });
    const restored = client.restoreHistory({
      restoreId: "restored",
      targetVersion: 1,
    });
    const rejectedRestore = client.restoreHistory({
      restoreId: "rejected-restore",
      targetVersion: 1,
    });
    const rejectedCheck = expect(rejected).rejects.toMatchObject({
      clientActionId: "rejected",
    });
    const rejectedRestoreCheck = expect(rejectedRestore).rejects.toMatchObject({
      restoreId: "rejected-restore",
    });
    const socket = expectSingleSocket(factory);
    socket.emitJson({
      type: "gameplay.backpressure",
      reason: "queue_full",
      retryAfterMs: 100,
      message: "Queue full",
      operation: "interaction.submit",
      clientActionId: "rejected",
    });
    socket.emitJson({
      type: "gameplay.backpressure",
      reason: "queue_full",
      retryAfterMs: 100,
      message: "Queue full",
      operation: "history.restore",
      restoreId: "rejected-restore",
    });
    socket.emitJson({
      type: "interaction.result",
      clientActionId: "accepted",
      accepted: true,
    });
    socket.emitJson({
      type: "history.restored",
      restoreId: "restored",
      version: 5,
    });
    await Promise.all([
      rejectedCheck,
      rejectedRestoreCheck,
      expect(accepted).resolves.toMatchObject({
        accepted: true,
        clientActionId: "accepted",
      }),
      expect(restored).resolves.toMatchObject({ restoreId: "restored" }),
    ]);
    client.close();
  });

  test("resumes and streams snapshot frames", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await authenticate(factory);
    const client = await clientPromise;
    const socket = expectSingleSocket(factory);
    client.resume();
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "session.resume",
      lastSeenLogCursor: null,
      unacknowledgedClientActionIds: [],
    });

    const iterator = client.frames()[Symbol.asyncIterator]();
    const nextFrame = iterator.next();
    socket.emitJson(SNAPSHOT_FRAME);

    await expect(nextFrame).resolves.toMatchObject({
      done: false,
      value: {
        type: "session.snapshot",
        frame: { basis: { version: 4 } },
      },
    });
    await iterator.return?.();
  });

  test("restores and rejects history frames", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await authenticate(factory);
    const client = await clientPromise;
    const restored = client.restoreHistory({
      restoreId: "restore-1",
      targetVersion: 7,
    });

    expect(JSON.parse(expectSingleSocket(factory).sent[1] ?? "{}")).toEqual({
      type: "history.restore",
      restoreId: "restore-1",
      targetVersion: 7,
    });

    expectSingleSocket(factory).emitJson({
      type: "history.restoreRejected",
      restoreId: "restore-1",
      errorCode: "history-target-not-found",
      message: "History restore target is not durable.",
      currentVersion: 4,
    });

    await expect(restored).resolves.toMatchObject({
      type: "history.restoreRejected",
      restoreId: "restore-1",
      errorCode: "history-target-not-found",
    });
  });

  test("correlates rejection and success to separate pending restores", async () => {
    const factory = createFakeWebSocketFactory();
    const clientPromise = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });
    await authenticate(factory);
    const client = await clientPromise;
    const first = client.restoreHistory({
      restoreId: "restore-1",
      targetVersion: 7,
    });
    const second = client.restoreHistory({
      restoreId: "restore-2",
      targetVersion: 3,
    });
    expectSingleSocket(factory).emitJson({
      type: "history.restoreRejected",
      restoreId: "restore-1",
      errorCode: "history-target-not-found",
      message: "History restore target is not durable.",
    });
    await expect(first).resolves.toMatchObject({
      type: "history.restoreRejected",
      restoreId: "restore-1",
    });
    expectSingleSocket(factory).emitJson({
      type: "history.restored",
      restoreId: "restore-2",
      version: 8,
    });
    await expect(second).resolves.toEqual({
      type: "history.restored",
      restoreId: "restore-2",
      version: 8,
    });
  });

  test("fails invalid server frames", async () => {
    const factory = createFakeWebSocketFactory();
    const client = connectGameplayAuthority({
      websocketUrl: WEBSOCKET_URL,
      credential: CREDENTIAL,
      sessionId: SESSION_ID,
      playerId: PLAYER_ID,
      webSocketFactory: factory.ctor,
    });

    await flushPromises();
    const socket = expectSingleSocket(factory);
    socket.emit("open");
    await flushPromises();
    socket.emitJson({ type: "unknown" });

    await expect(client).rejects.toThrow();
    expect(socket.closed).toBe(true);
  });
});

class FakeWebSocket implements GameplayAuthorityWebSocketLike {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: GameplayAuthorityWebSocketInit,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  emitJson(payload: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}

class FakeBrowserWebSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: unknown,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(event: string, listener: EventListener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(new Event(event));
    }
  }

  emitMessage(payload: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}

function createFakeWebSocketFactory() {
  const instances: FakeWebSocket[] = [];
  return {
    instances,
    ctor: class extends FakeWebSocket {
      constructor(url: string, init?: GameplayAuthorityWebSocketInit) {
        super(url, init);
        instances.push(this);
      }
    },
  };
}

function createFakeBrowserWebSocketFactory() {
  const instances: FakeBrowserWebSocket[] = [];
  return {
    instances,
    ctor: class extends FakeBrowserWebSocket {
      constructor(url: string, init?: unknown) {
        super(url, init);
        instances.push(this);
      }
    },
  };
}

function expectSingleSocket(factory: {
  instances: FakeWebSocket[];
}): FakeWebSocket {
  expect(factory.instances).toHaveLength(1);
  return factory.instances[0] as FakeWebSocket;
}

function expectSingleBrowserSocket(factory: {
  instances: FakeBrowserWebSocket[];
}): FakeBrowserWebSocket {
  expect(factory.instances).toHaveLength(1);
  return factory.instances[0] as FakeBrowserWebSocket;
}

async function authenticate(factory: {
  instances: FakeWebSocket[];
}): Promise<void> {
  await flushPromises();
  const socket = expectSingleSocket(factory);
  expect(socket.url).toBe(WEBSOCKET_URL);
  socket.emit("open");
  await flushPromises();
  expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
    type: "auth.connect",
    credential: CREDENTIAL,
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
  });
  socket.emitJson({
    type: "auth.accepted",
    expiresAt: EXPIRES_AT,
  });
  await flushPromises();
}

async function authenticateBrowser(
  factory: {
    instances: FakeBrowserWebSocket[];
  },
  index = 0,
): Promise<void> {
  await flushPromises();
  const socket = factory.instances[index];
  if (!socket) {
    throw new Error("Expected browser websocket to be constructed.");
  }
  expect(socket.url).toBe(WEBSOCKET_URL);
  expect(socket.init).toBeUndefined();
  socket.emit("open");
  await flushPromises();
  expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
    type: "auth.connect",
    credential: CREDENTIAL,
    sessionId: SESSION_ID,
    playerId: PLAYER_ID,
  });
  socket.emitMessage({
    type: "auth.accepted",
    expiresAt: EXPIRES_AT,
  });
  await flushPromises();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
