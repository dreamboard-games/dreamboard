import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { REDUCER_CONTRACT_VERSION } from "@dreamboard-games/sdk/reducer";
const runtime = await readFile(
  new URL("../dist/index.js", import.meta.url),
  "utf8",
);
const state = {
  domain: {
    table: { playerOrder: ["alice", "bob"] },
    publicState: { count: 0 },
    privateState: { alice: { secret: "A" }, bob: { secret: "B" } },
    hiddenState: { secret: "host-only" },
    flow: { currentPhase: "play", turn: 1, round: 1, activePlayers: ["alice"] },
    phase: {},
  },
  runtime: {
    rng: { seed: 1, cursor: 0, trace: [] },
    options: {},
    pending: {},
    events: [],
    simultaneous: { current: null },
    lastTransition: null,
  },
};
const source = `export default {
 reducerContractVersion:${JSON.stringify(REDUCER_CONTRACT_VERSION)},
 initialize(input){const state=${JSON.stringify(state)};state.domain.table.playerOrder=input.playerIds;state.runtime.options=input.options??{};return {state}},
 dispatch({state,input}){if(input.interactionId==='hang')while(true){};state.domain.publicState.count++;return {kind:'accept',state,trace:[],events:[]}},
 project({state,playerIds}){return {events:state.runtime.events,interactionsByRef:{},seats:Object.fromEntries(playerIds.map(id=>[id,{view:{...state.domain.publicState,...state.domain.privateState[id]},availableInteractionRefs:[],zones:{}}]))}},
 boardStatic(){return null}
}`;
test.beforeEach(async ({ page }) => {
  await page.route("http://localhost:4199/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("http://localhost:4199/");
  await page.evaluate(async (code) => {
    const url = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" }),
    );
    (window as any).runtimeModule = await import(url);
  }, runtime);
});
test("offline initialize, serialized dispatch, seat projection, persistence and reset", async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  const result = await page.evaluate(async (source) => {
    const records: any[] = [];
    const game = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: { table: {}, playerIds: ["alice", "bob"] },
      persist: async (value: any) => {
        await new Promise((r) => setTimeout(r, 10));
        records.push(value);
      },
    });
    const start = await game.start();
    await Promise.all([
      game.dispatch({
        kind: "interaction",
        playerId: "alice",
        interactionId: "increment",
        params: {},
      }),
      game.dispatch({
        kind: "interaction",
        playerId: "alice",
        interactionId: "increment",
        params: {},
      }),
    ]);
    const switched = await game.selectSeat("bob");
    const restored = (window as any).runtimeModule.createBrowserGameplayRuntime(
      {
        reducerSource: source,
        initialize: { table: {}, playerIds: ["alice", "bob"] },
        restored: records.at(-1),
        persist: async () => {},
      },
    );
    const resumed = await restored.start();
    const reset = await game.reset();
    game.dispose();
    restored.dispose();
    return {
      start,
      switched,
      resumed,
      reset,
      counts: records.map((v) => v.state.domain.publicState.count),
    };
  }, source);
  expect(result.start.projection.seats).toEqual({
    alice: {
      view: { count: 0, secret: "A" },
      availableInteractionRefs: [],
      zones: {},
    },
  });
  expect(result.switched.projection.seats).toEqual({
    bob: {
      view: { count: 2, secret: "B" },
      availableInteractionRefs: [],
      zones: {},
    },
  });
  expect(result.resumed.projection.seats.alice.view.count).toBe(2);
  expect(result.reset.playerId).toBe("bob");
  expect(result.reset.projection.seats.bob.view.count).toBe(0);
  expect(result.reset.projection.seats.alice).toBeUndefined();
  expect(result.counts).toEqual([0, 1, 2, 0]);
  expect(JSON.stringify(result.start)).not.toContain("host-only");
});
test("terminates an infinite worker and resets the session", async ({
  page,
}) => {
  const result = await page.evaluate(async (source) => {
    const game = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: { table: {}, playerIds: ["alice"] },
      persist: async () => {},
      operationTimeoutMs: 300,
    });
    await game.start();
    let error = "";
    try {
      await game.dispatch({
        kind: "interaction",
        playerId: "alice",
        interactionId: "hang",
        params: {},
      });
    } catch (e) {
      error = String(e);
    }
    const reset = await game.reset();
    game.dispose();
    return { error, reset };
  }, source);
  expect(result.error).toContain("timed out");
  expect(result.reset.projection.seats.alice.view.count).toBe(0);
  expect(await page.locator("iframe").count()).toBe(0);
});
test("opaque worker cannot access storage or network", async ({ page }) => {
  const malicious = source.replace(
    "initialize(input){",
    `async initialize(input){
 let storage=false,network=false;
 try{await indexedDB.open('parent-private');storage=true}catch{}
 try{await fetch('http://localhost:4199/secret',{credentials:'include'});network=true}catch{}
 if(storage||network)throw new Error('Isolation failed');
 `,
  );
  const result = await page.evaluate(async (source) => {
    localStorage.setItem("credential", "do-not-read");
    const game = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: { table: {}, playerIds: ["alice"] },
      persist: async () => {},
    });
    const result = await game.start();
    game.dispose();
    return result;
  }, malicious);
  expect(result.projection.seats.alice.view.count).toBe(0);
});
test("failed persistence leaves committed state unchanged", async ({
  page,
}) => {
  const result = await page.evaluate(async (source) => {
    let fail = false;
    const game = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: { table: {}, playerIds: ["alice"] },
      persist: async () => {
        if (fail) throw new Error("Disk full");
      },
    });
    await game.start();
    fail = true;
    let error = "";
    try {
      await game.dispatch({
        kind: "interaction",
        playerId: "alice",
        interactionId: "increment",
        params: {},
      });
    } catch (e) {
      error = String(e);
    }
    const snapshot = await game.selectSeat("alice");
    game.dispose();
    return { error, snapshot };
  }, source);
  expect(result.error).toContain("Disk full");
  expect(result.snapshot.projection.seats.alice.view.count).toBe(0);
});
test("each reducer operation loads a fresh module", async ({ page }) => {
  const mutating = source
    .replace("export default", "let calls=0; export default")
    .replace(
      "project({state,playerIds}){return",
      "project({state,playerIds}){if(++calls>1)throw new Error('Module leaked');return",
    );
  await page.evaluate(async (source) => {
    const game = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: { table: {}, playerIds: ["alice"] },
      persist: async () => {},
    });
    await game.start();
    await game.selectSeat("alice");
    await game.selectSeat("alice");
    game.dispose();
  }, mutating);
});
test("shared UI bridge renders only a seat and submits offline interactions", async ({
  page,
  context,
}) => {
  await page.evaluate(
    async (source) => {
      const module = (window as any).runtimeModule;
      (window as any).oldSeatFrames = [];
      const send = module.PluginBridge.prototype.sendGameplayFrame;
      module.PluginBridge.prototype.sendGameplayFrame = function (frame: any) {
        if (this.iframe === (window as any).oldFrame)
          (window as any).oldSeatFrames.push(frame.basis.perspectivePlayerId);
        return send.call(this, frame);
      };
      const runtime = module.createBrowserGameplayRuntime({
        reducerSource: source,
        initialize: { table: {}, playerIds: ["alice", "bob"] },
        persist: async () => {},
      });
      const initialSnapshot = await runtime.start();
      const html = `<button id="increment">Increment</button><pre></pre><script>
  let host,frame;
  setTimeout(()=>addEventListener('message',event=>{
   if(event.source!==parent)return;
   if(event.data.payload.type==='runtime.init'){
    host=event.data;parent.postMessage({...host,sequence:1,payload:{type:'runtime.ready'}},event.origin);
   }
   if(event.data.payload.type==='gameplay.frame'){
    frame=event.data.payload.frame;document.querySelector('pre').textContent=JSON.stringify(frame);
   }
  }), 600);
  document.querySelector('button').onclick=()=>parent.postMessage({...host,sequence:2,payload:{type:'interaction.submit',clientActionId:crypto.randomUUID(),basis:frame.basis,interactionId:'increment',params:{}}},'*');
  </script>`;
      (window as any).ui = module.mountGameplayUI({
        container: document.body,
        html,
        runtime,
        initialSnapshot,
        sessionId: "test",
        assets: {
          alice: "do-not-replace-basis",
          "https://images.test/card": "data:image/png;base64,AA==",
        },
        players: [
          { playerId: "alice", displayName: "Alice" },
          { playerId: "bob", displayName: "Bob" },
        ],
      });
    },
    source.replace(
      "view:{...state.domain.publicState,...state.domain.privateState[id]}",
      "view:{...state.domain.publicState,...state.domain.privateState[id],imageUrl:'https://images.test/card'}",
    ),
  );
  const game = page.frameLocator('iframe[title="Game"]');
  await expect(game.locator("pre")).toContainText('"secret":"A"');
  await expect(game.locator("pre")).not.toContainText("host-only");
  await expect(game.locator("pre")).not.toContainText('"secret":"B"');
  await expect(game.locator("pre")).toContainText("data:image/png;base64,AA==");
  await page.evaluate(() => {
    (window as any).oldFrame = document.querySelector('iframe[title="Game"]');
  });
  await context.setOffline(true);
  await game.getByRole("button").click();
  await expect(game.locator("pre")).toContainText('"count":1');
  await page.evaluate(() => (window as any).ui.selectSeat("bob"));
  await expect(game.locator("pre")).toContainText('"secret":"B"');
  await expect(game.locator("pre")).not.toContainText('"secret":"A"');
  expect(
    await page.evaluate(() => (window as any).oldSeatFrames),
  ).not.toContain("bob");
});

async function mountRetryGame(
  page: import("@playwright/test").Page,
  failNotification = false,
) {
  await page.evaluate(
    async ({ source, failNotification }) => {
      const module = (window as any).runtimeModule;
      const host = window as any;
      host.persisted = [];
      host.errors = [];
      host.dropNextResult = false;
      const send = module.PluginBridge.prototype.sendSubmitResult;
      module.PluginBridge.prototype.sendSubmitResult = function (result: any) {
        if (host.dropNextResult) {
          host.dropNextResult = false;
          return null;
        }
        return send.call(this, result);
      };
      const runtime = module.createBrowserGameplayRuntime({
        reducerSource: source,
        initialize: { table: {}, playerIds: ["alice", "bob"] },
        persist: async (value: any) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          host.persisted.push(value.state.domain.publicState.count);
        },
      });
      host.gameRuntime = runtime;
      const initialSnapshot = await runtime.start();
      const html = `<script>
      let host, sequence = 0;
      window.framesSeen = []; window.results = [];
      window.submit = command => parent.postMessage({...host,sequence:++sequence,payload:command}, '*');
      addEventListener('message', event => {
        if(event.source !== parent) return;
        const payload = event.data.payload;
        if(payload.type === 'runtime.init') {
          host=event.data;
          parent.postMessage({...host,sequence:++sequence,payload:{type:'runtime.ready'}}, '*');
        }
        if(payload.type === 'gameplay.frame') { window.frame=payload.frame; window.framesSeen.push(payload.frame); }
        if(payload.type === 'interaction.result') window.results.push(payload);
      });
    </script>`;
      host.ui = module.mountGameplayUI({
        container: document.body,
        html,
        runtime,
        initialSnapshot,
        sessionId: "retry-test",
        players: [
          { playerId: "alice", displayName: "Alice" },
          { playerId: "bob", displayName: "Bob" },
        ],
        onSnapshot: (snapshot: any) => {
          if (
            failNotification &&
            snapshot.projection.seats[snapshot.playerId].view.count > 0
          )
            throw new Error("Notification failed");
        },
        onError: (error: unknown) => host.errors.push(String(error)),
      });
    },
    {
      source,
      failNotification,
    },
  );
  const ui = page.frameLocator('iframe[title="Game"]');
  await expect
    .poll(() =>
      ui
        .locator("body")
        .evaluate(() => (window as any).frame?.basis.perspectivePlayerId),
    )
    .toBe("alice");
  return ui;
}

test("lost ACK and queued exact retries reuse the commit, while changed requests and stale new commands reject", async ({
  page,
}) => {
  const ui = await mountRetryGame(page);
  const command = await ui.locator("body").evaluate(() => ({
    type: "interaction.submit",
    clientActionId: "first",
    basis: (window as any).frame.basis,
    interactionId: "increment",
    params: { a: 1, b: 2 },
  }));
  await page.evaluate(() => {
    (window as any).dropNextResult = true;
  });
  await ui.locator("body").evaluate((_body, command) => {
    (window as any).submit(command);
    (window as any).submit({ ...command, params: { b: 2, a: 1 } });
  }, command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(1);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results[0].accepted),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([0, 1]);
  // Retry the original basis after a later commit: return the recorded result
  // alongside the latest frame, never the old result's private snapshot.
  await ui.locator("body").evaluate(() =>
    (window as any).submit({
      type: "interaction.submit",
      clientActionId: "second",
      basis: (window as any).frame.basis,
      interactionId: "increment",
      params: {},
    }),
  );
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(2);
  await ui
    .locator("body")
    .evaluate((_body, command) => (window as any).submit(command), command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(3);
  expect(
    await ui.locator("body").evaluate(() => (window as any).frame.view.count),
  ).toBe(2);
  for (const changed of [
    { ...command, params: { a: 9 } },
    { ...command, interactionId: "other" },
    { ...command, basis: { ...command.basis, version: 999 } },
    { ...command, clientActionId: "stale-new" },
  ])
    await ui
      .locator("body")
      .evaluate((_body, value) => (window as any).submit(value), changed);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(7);
  expect(
    await ui
      .locator("body")
      .evaluate(() =>
        (window as any).results.slice(3).map((r: any) => r.accepted),
      ),
  ).toEqual([false, false, false, false]);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([
    0, 1, 2,
  ]);
});

test("committed result survives snapshot callback failure and seat changes preserve privacy and identity", async ({
  page,
}) => {
  const ui = await mountRetryGame(page, true);
  const command = await ui.locator("body").evaluate(() => ({
    type: "interaction.submit",
    clientActionId: "same-id",
    basis: (window as any).frame.basis,
    interactionId: "increment",
    params: {},
  }));
  await ui
    .locator("body")
    .evaluate((_body, command) => (window as any).submit(command), command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(1);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results[0].accepted),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).errors)).toContain(
    "Error: Notification failed",
  );
  await page.evaluate(() => (window as any).ui.selectSeat("bob"));
  await expect
    .poll(() =>
      ui
        .locator("body")
        .evaluate(() => (window as any).frame?.basis.perspectivePlayerId),
    )
    .toBe("bob");
  await ui.locator("body").evaluate((_body, command) => {
    (window as any).submit(command);
    (window as any).submit({ ...command, basis: (window as any).frame.basis });
  }, command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(2);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results.map((r: any) => r.accepted)),
  ).toEqual([false, false]);
  const frames = await ui
    .locator("body")
    .evaluate(() => JSON.stringify((window as any).framesSeen));
  expect(frames).toContain('"secret":"B"');
  expect(frames).not.toContain('"secret":"A"');
  await page.evaluate(() => (window as any).ui.selectSeat("alice"));
  await expect
    .poll(() =>
      ui
        .locator("body")
        .evaluate(() => (window as any).frame?.basis.perspectivePlayerId),
    )
    .toBe("alice");
  await ui
    .locator("body")
    .evaluate((_body, command) => (window as any).submit(command), command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(1);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results[0].accepted),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([0, 1]);
});

test("a command queued behind a seat switch cannot act for or notify the new seat; reset clears retry history", async ({
  page,
}) => {
  const ui = await mountRetryGame(page);
  const command = await ui.locator("body").evaluate(() => ({
    type: "interaction.submit",
    clientActionId: "reusable-after-reset",
    basis: (window as any).frame.basis,
    interactionId: "increment",
    params: {},
  }));
  await ui
    .locator("body")
    .evaluate((_body, command) => (window as any).submit(command), command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(1);
  await page.evaluate(() => {
    const host = window as any;
    const original = host.gameRuntime.selectSeat;
    host.gameRuntime.selectSeat = async (seat: string) => {
      await new Promise<void>((resolve) => {
        host.releaseSeat = resolve;
      });
      return original(seat);
    };
    host.switched = host.ui.selectSeat("bob");
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseSeat))
    .toBe("function");
  // A barrier on the parent's message event confirms delivery before releasing
  // the queued seat switch, without timing assumptions about iframe IPC.
  await page.evaluate(() => {
    (window as any).delivered = new Promise<void>((resolve) => {
      window.addEventListener("message", function listener(event) {
        if (event.data?.payload?.clientActionId !== "reusable-after-reset")
          return;
        window.removeEventListener("message", listener);
        resolve();
      });
    });
  });
  await ui
    .locator("body")
    .evaluate((_body, command) => (window as any).submit(command), command);
  await page.evaluate(async () => {
    const host = window as any;
    await host.delivered;
    host.releaseSeat();
    await host.switched;
  });
  await expect
    .poll(() =>
      ui
        .locator("body")
        .evaluate(() => (window as any).frame?.basis.perspectivePlayerId),
    )
    .toBe("bob");
  expect(
    await ui.locator("body").evaluate(() => (window as any).results),
  ).toEqual([]);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([0, 1]);
  await page.evaluate(() => (window as any).ui.reset());
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).frame?.view.count),
    )
    .toBe(0);
  await ui.locator("body").evaluate(
    (_body, command) =>
      (window as any).submit({
        ...command,
        basis: (window as any).frame.basis,
      }),
    command,
  );
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(1);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results[0].accepted),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([
    0, 1, 0, 1,
  ]);
});

test("cancel retries share identity admission and resume republishes without dispatch", async ({
  page,
}) => {
  const ui = await mountRetryGame(page);
  const basis = await ui
    .locator("body")
    .evaluate(() => (window as any).frame.basis);
  const command = {
    type: "interaction.cancel",
    clientActionId: "cancel-once",
    basis,
    interactionId: "increment",
  };
  await ui.locator("body").evaluate((_body, command) => {
    (window as any).submit(command);
    (window as any).submit(command);
  }, command);
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(2);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([0, 1]);
  expect(
    await ui
      .locator("body")
      .evaluate(() =>
        (window as any).results.every((result: any) => result.accepted),
      ),
  ).toBe(true);
  const before = await ui.locator("body").evaluate(() => ({
    count: (window as any).framesSeen.length,
    version: (window as any).frame.basis.version,
  }));
  await ui
    .locator("body")
    .evaluate(() => (window as any).submit({ type: "runtime.resume" }));
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).framesSeen.length),
    )
    .toBe(before.count + 1);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).frame.basis.version),
  ).toBe(before.version);
  expect(await page.evaluate(() => (window as any).persisted)).toEqual([0, 1]);
  await ui.locator("body").evaluate(
    (_body, command) =>
      (window as any).submit({
        ...command,
        type: "interaction.submit",
        params: {},
      }),
    command,
  );
  await expect
    .poll(() =>
      ui.locator("body").evaluate(() => (window as any).results.length),
    )
    .toBe(3);
  expect(
    await ui
      .locator("body")
      .evaluate(() => (window as any).results.at(-1).accepted),
  ).toBe(false);
});

test("checkpoint restoration replaces the UI lifetime with a fresh revision", async ({
  page,
}) => {
  const ui = await mountRetryGame(page);
  const before = await ui
    .locator("body")
    .evaluate(() => (window as any).frame.basis.version);
  await page.evaluate(async () => {
    const host = window as any;
    const checkpoint = await host.ui.checkpoint();
    host.originalCheckpoint = JSON.parse(JSON.stringify(checkpoint));
    await host.ui.restore(host.originalCheckpoint);
  });
  const restored = page.frameLocator('iframe[title="Game"]');
  await expect
    .poll(() =>
      restored
        .locator("body")
        .evaluate(() => (window as any).frame?.basis.version),
    )
    .toBeGreaterThan(before);
  expect(
    await page.evaluate(
      async () =>
        JSON.stringify(await (window as any).ui.checkpoint()) ===
        JSON.stringify((window as any).originalCheckpoint),
    ),
  ).toBe(true);
});

test("restored checkpoints retain options, events, pending choices and RNG without replay", async ({
  page,
}) => {
  const result = await page.evaluate(async (source) => {
    const runtime = (window as any).runtimeModule.createBrowserGameplayRuntime({
      reducerSource: source,
      initialize: {
        table: {},
        playerIds: ["alice", "bob"],
        options: { target: 7 },
      },
      persist: async () => {},
    });
    await runtime.start();
    const checkpoint = JSON.parse(JSON.stringify(await runtime.checkpoint()));
    checkpoint.state.runtime.pending.alice = {
      phaseName: "play",
      interactionId: "choose",
      values: ["first"],
    };
    checkpoint.state.runtime.rng.cursor = 9;
    checkpoint.state.runtime.events = [
      { kind: "systemAction", procedureId: "saved", title: "Saved event" },
    ];
    const restored = await runtime.restore(checkpoint);
    const switched = await runtime.selectSeat("bob");
    const after = await runtime.checkpoint();
    const malformed = structuredClone(checkpoint);
    malformed.state.domain.table.playerOrder.reverse();
    let rejected = false;
    try {
      await runtime.restore(malformed);
    } catch {
      rejected = true;
    }
    const unchanged =
      JSON.stringify(await runtime.checkpoint()) === JSON.stringify(after);
    runtime.dispose();
    return { restored, switched, after, checkpoint, rejected, unchanged };
  }, source);
  expect(result.after).toEqual(result.checkpoint);
  expect(result.restored.events).toEqual(
    result.checkpoint.state.runtime.events,
  );
  expect(result.switched.events).toEqual(result.restored.events);
  expect(result.after.state.runtime.options).toEqual({ target: 7 });
  expect(result.rejected).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(JSON.stringify(result.restored)).not.toContain("host-only");
});

test("queued direct commands preserve the caller's original values", async ({
  page,
}) => {
  const result = await page.evaluate(
    async (source) => {
      const runtime = (
        window as any
      ).runtimeModule.createBrowserGameplayRuntime({
        reducerSource: source,
        initialize: { table: {}, playerIds: ["alice"] },
        persist: async () => {},
      });
      await runtime.start();
      const input = {
        kind: "interaction",
        playerId: "alice",
        interactionId: "increment",
        params: { value: "original" },
      };
      const pending = runtime.dispatch(input);
      input.params.value = "changed";
      await pending;
      const checkpoint = await runtime.checkpoint();
      runtime.dispose();
      return checkpoint.state.domain.publicState.observed;
    },
    source.replace(
      "state.domain.publicState.count++;",
      "state.domain.publicState.observed=input.params.value;state.domain.publicState.count++;",
    ),
  );
  expect(result).toBe("original");
});
