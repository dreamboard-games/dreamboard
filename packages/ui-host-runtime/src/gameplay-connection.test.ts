import { describe, expect, test } from "vitest";
import type {
  GameplayAuthorityClient,
  GameplayCredential,
  RestoreGameplayHistoryInput,
  HistoryRestoredFrame,
  ResumeGameplaySessionInput,
  ServerGameplayFrame,
} from "@dreamboard-games/gameplay-authority-client";
import type {
  InteractionResult,
  SubmitInteractionCommand,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import { createGameplayAuthorityTransport } from "./gameplay-authority-transport.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000401";

function requireNextClient(clients: FakeClient[]): FakeClient {
  const client = clients.shift();
  if (!client) {
    throw new Error("Expected another fake gameplay client.");
  }
  return client;
}

describe("StatefulGameplayConnection", () => {
  test("waits for resume snapshot and refreshes the existing client before expiry", async () => {
    const requests: string[] = [];
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    const client = new FakeClient();
    const connection = createGameplayAuthorityTransport({
      getCredential: requester(requests),
      clientConnector: async () => client,
      now: () => 0,
      schedule: (delayMs, task) => {
        scheduled.push({ delayMs, task });
        return { cancel() {} };
      },
    });

    await connection.connect(connectInput());

    expect(connection.state).toBe("open");
    expect(client.resumes).toEqual([
      { lastSeenLogCursor: 7, unacknowledgedClientActionIds: [] },
    ]);
    expect(scheduled[0]?.delayMs).toBe(80_000);

    scheduled[0]?.task();
    await flushPromises();
    expect(client.refreshTokens).toEqual([{ kind: "user", token: "token-2" }]);
    expect(requests).toEqual(["token-1", "token-2"]);
    expect(connection.state).toBe("open");
    expect(scheduled).toHaveLength(1); // Unchanged expiry must not schedule a shrinking refresh loop.
  });

  test("retains a pending action id through reconnect and retries on the replacement client", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    first.holdSubmissions = true;
    const clients = [first, second];
    const connection = createGameplayAuthorityTransport({
      getCredential: requester([]),
      clientConnector: async () => requireNextClient(clients),
      sleep: async () => undefined,
      random: () => 0.5,
    });
    await connection.connect(connectInput());

    const submitted = connection.submit(command("action-1", "player-1"));
    await flushPromises();
    first.fail(new Error("socket closed"));

    await expect(submitted).resolves.toEqual({
      type: "interaction.result",
      clientActionId: "action-1",
      accepted: true,
    });
    expect(second.resumes[0]).toEqual({
      lastSeenLogCursor: 7,
      unacknowledgedClientActionIds: ["action-1"],
    });
    expect(second.submissions.map((entry) => entry.clientActionId)).toEqual([
      "action-1",
    ]);
  });

  test("switches only to an authorized perspective and refuses while a command is pending", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    first.holdSubmissions = true;
    const clients = [first, second];
    const requests: string[] = [];
    const connection = createGameplayAuthorityTransport({
      getCredential: requester(requests),
      clientConnector: async () => requireNextClient(clients),
    });
    await connection.connect(connectInput());
    const pending = connection.submit(command("action-1", "player-1"));
    await flushPromises();

    await expect(connection.switchPerspective("player-2")).rejects.toThrow(
      /interactions are pending/,
    );
    first.resolveSubmission();
    await pending;
    await connection.switchPerspective("player-2");

    expect(requests).toEqual(["token-1", "token-2"]);
    expect(second.resumes).toHaveLength(1);
    await expect(connection.switchPerspective("player-3")).rejects.toThrow(
      /not authorized/,
    );
  });

  test("explicit close is terminal and does not reconnect", async () => {
    const client = new FakeClient();
    let connects = 0;
    const connection = createGameplayAuthorityTransport({
      getCredential: requester([]),
      clientConnector: async () => {
        connects += 1;
        return client;
      },
      sleep: async () => undefined,
    });
    await connection.connect(connectInput());
    connection.close();
    client.fail(new Error("late socket close"));
    await flushPromises();

    expect(connection.state).toBe("closed");
    expect(connects).toBe(1);
  });
  test("demo credentials do not schedule token refresh", async () => {
    const scheduled: number[] = [];
    const connection = createGameplayAuthorityTransport({
      getCredential: async () => ({ kind: "demo", secret: "demo-secret" }),
      clientConnector: async () => new FakeClient(),
      schedule: (delay) => {
        scheduled.push(delay);
        return { cancel() {} };
      },
    });
    await connection.connect(connectInput());
    expect(scheduled).toEqual([]);
    connection.close();
  });

  test("restore retries the original id after a lost response", async () => {
    const first = new FakeClient();
    first.failRestore = true;
    const second = new FakeClient();
    const clients = [first, second];
    const connection = createGameplayAuthorityTransport({
      getCredential: requester([]),
      clientConnector: async () => requireNextClient(clients),
      sleep: async () => undefined,
      randomClientActionId: () => "stable-restore-id",
    });
    await connection.connect(connectInput());
    await connection.restoreHistory({ targetVersion: 2 });
    expect(first.restores).toEqual([
      { restoreId: "stable-restore-id", targetVersion: 2 },
    ]);
    expect(second.restores).toEqual(first.restores);
    connection.close();
  });
});

class FakeClient implements GameplayAuthorityClient {
  readonly resumes: ResumeGameplaySessionInput[] = [];
  readonly refreshTokens: GameplayCredential[] = [];
  readonly restores: RestoreGameplayHistoryInput[] = [];
  failRestore = false;
  readonly submissions: SubmitInteractionCommand[] = [];
  holdSubmissions = false;
  private queue: ServerGameplayFrame[] = [];
  private wake?: () => void;
  private failure?: Error;
  private submission?: {
    resolve(result: InteractionResult): void;
    reject(error: Error): void;
  };

  constructor(public expiresAt = "1970-01-01T00:01:40.000Z") {}

  async refresh(
    credential: GameplayCredential,
  ): Promise<{ expiresAt: string }> {
    this.refreshTokens.push(credential);
    return { expiresAt: this.expiresAt };
  }

  resume(input: ResumeGameplaySessionInput = {}): void {
    this.resumes.push(input);
    queueMicrotask(() => this.emit(snapshot(this.resumes.length - 1)));
  }

  async submit(command: SubmitInteractionCommand): Promise<InteractionResult> {
    this.submissions.push(command);
    if (!this.holdSubmissions) {
      return {
        type: "interaction.result",
        clientActionId: command.clientActionId,
        accepted: true,
      };
    }
    return await new Promise<InteractionResult>((resolve, reject) => {
      this.submission = { resolve, reject };
    });
  }

  resolveSubmission(): void {
    const command = this.submissions.at(-1);
    if (!command) throw new Error("No pending submission.");
    this.submission?.resolve({
      type: "interaction.result",
      clientActionId: command.clientActionId,
      accepted: true,
    });
    this.submission = undefined;
  }

  async restoreHistory(
    input: RestoreGameplayHistoryInput,
  ): Promise<HistoryRestoredFrame> {
    this.restores.push(input);
    if (this.failRestore) throw new Error("restore reply lost");
    return { type: "history.restored", restoreId: input.restoreId, version: 5 };
  }

  async *frames(signal?: AbortSignal): AsyncGenerator<ServerGameplayFrame> {
    while (!signal?.aborted) {
      if (this.failure) throw this.failure;
      const frame = this.queue.shift();
      if (frame) {
        yield frame;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal?.addEventListener("abort", resolve, { once: true });
      });
    }
  }

  emit(frame: ServerGameplayFrame): void {
    this.queue.push(frame);
    this.wake?.();
    this.wake = undefined;
  }

  fail(error: Error): void {
    this.failure = error;
    this.submission?.reject(error);
    this.submission = undefined;
    this.wake?.();
    this.wake = undefined;
  }

  close(): void {}
}

function requester(requests: string[]): () => Promise<GameplayCredential> {
  let count = 0;
  return async () => {
    const token = `token-${++count}`;
    requests.push(token);
    return { kind: "user", token };
  };
}

function connectInput() {
  return {
    sessionId: SESSION_ID,
    websocketUrl: "wss://authority.test/v1/connect",
    playerId: "player-1",
    switchablePlayerIds: ["player-1", "player-2"],
    lastSeenLogCursor: 7,
    handlers: { onEvent() {}, onStateChange() {} },
  };
}

function command(
  clientActionId: string,
  playerId: string,
): SubmitInteractionCommand {
  return {
    type: "interaction.submit",
    clientActionId,
    basis: {
      version: 0,
      actionSetVersion: "actions-0",
      perspectivePlayerId: playerId,
    },
    interactionId: "play-card",
    params: {},
  };
}

function snapshot(version: number): ServerGameplayFrame {
  return {
    type: "session.snapshot",
    boardStatic: null,
    frame: {
      basis: {
        version,
        actionSetVersion: `actions-${version}`,
        perspectivePlayerId: "player-1",
      },
      view: null,
      flow: {
        currentPhase: "main",
        currentStage: null,
        activePlayers: ["player-1"],
        simultaneousPhase: null,
      },
      availableInteractions: [],
      recentEvents: [],
      zones: {},
    },
    history: { entries: [] },
    lifecycle: { status: "active" },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
