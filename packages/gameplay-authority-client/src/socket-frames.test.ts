import { describe, expect, test } from "vitest";
import {
  readServerFrames,
  waitForServerFrame,
  type GameplayAuthorityWebSocketLike,
} from "./socket-frames.js";

const AUTH_ACCEPTED = {
  type: "auth.accepted",
  expiresAt: "2026-06-02T00:00:00.000Z",
} as const;

const LOGS_RESET = {
  type: "gameplay.logs.reset",
  cursor: 0,
  reason: "retention-gap",
} as const;

describe("readServerFrames", () => {
  test("yields parsed frames in arrival order", async () => {
    const socket = new FakeSocket();
    const iterator = readServerFrames(socket)[Symbol.asyncIterator]();

    socket.emitJson(AUTH_ACCEPTED);
    socket.emitJson(LOGS_RESET);

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "auth.accepted" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "gameplay.logs.reset", cursor: 0 },
    });
    await iterator.return?.(undefined);
  });

  test("resolves frames awaited before they arrive", async () => {
    const socket = new FakeSocket();
    const iterator = readServerFrames(socket)[Symbol.asyncIterator]();

    const pending = iterator.next();
    socket.emitJson(AUTH_ACCEPTED);

    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { type: "auth.accepted" },
    });
    await iterator.return?.(undefined);
  });

  test("ends iteration and detaches listeners when the socket closes", async () => {
    const socket = new FakeSocket();
    const iterator = readServerFrames(socket)[Symbol.asyncIterator]();

    socket.emit("close");

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(socket.listenerCount("message")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  test("ends iteration when the abort signal fires", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const iterator = readServerFrames(socket, controller.signal)[
      Symbol.asyncIterator
    ]();

    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(socket.listenerCount("message")).toBe(0);
  });

  test("throws when a frame fails schema validation", async () => {
    const socket = new FakeSocket();
    const iterator = readServerFrames(socket)[Symbol.asyncIterator]();

    socket.emitJson({ type: "not-a-real-frame" });

    await expect(iterator.next()).rejects.toThrow();
    expect(socket.listenerCount("message")).toBe(0);
  });

  test("return() stops iteration and detaches listeners", async () => {
    const socket = new FakeSocket();
    const iterator = readServerFrames(socket)[Symbol.asyncIterator]();

    await iterator.return?.(undefined);

    expect(socket.listenerCount("message")).toBe(0);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("waitForServerFrame", () => {
  test("resolves with the first frame matching the predicate", async () => {
    const socket = new FakeSocket();
    const pending = waitForServerFrame(
      socket,
      (frame) => frame.type === "gameplay.logs.reset",
      1_000,
    );

    socket.emitJson(AUTH_ACCEPTED);
    socket.emitJson(LOGS_RESET);

    await expect(pending).resolves.toMatchObject({
      type: "gameplay.logs.reset",
    });
    expect(socket.listenerCount("message")).toBe(0);
  });

  test("rejects when a frame fails to parse", async () => {
    const socket = new FakeSocket();
    const pending = waitForServerFrame(socket, () => true, 1_000);

    socket.emitJson({ type: "not-a-real-frame" });

    await expect(pending).rejects.toThrow();
    expect(socket.listenerCount("message")).toBe(0);
  });

  test("rejects after the timeout elapses", async () => {
    const socket = new FakeSocket();
    await expect(waitForServerFrame(socket, () => true, 20)).rejects.toThrow(
      "gameplay socket timed out",
    );
    expect(socket.listenerCount("message")).toBe(0);
  });
});

class FakeSocket implements GameplayAuthorityWebSocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
