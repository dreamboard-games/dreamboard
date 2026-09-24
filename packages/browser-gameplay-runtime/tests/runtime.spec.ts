import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { REDUCER_CONTRACT_VERSION } from "@dreamboard-games/sdk/reducer-contract";
const runtime = await readFile(
  new URL("../dist/index.js", import.meta.url),
  "utf8",
);
const state = {
  domain: {
    table: {},
    publicState: { count: 0 },
    privateState: { alice: { secret: "A" }, bob: { secret: "B" } },
    hiddenState: { secret: "host-only" },
    flow: { currentPhase: "play", turn: 1, round: 1, activePlayers: ["alice"] },
    phase: {},
  },
  runtime: {
    rng: { seed: 1, cursor: 0, trace: [] },
    setup: null,
    simultaneous: { current: null },
    lastTransition: null,
  },
};
const source = `export default {
 reducerContractVersion:${JSON.stringify(REDUCER_CONTRACT_VERSION)},
 initialize(){return {state:${JSON.stringify(state)}}},
 dispatch({state,input}){if(input.interactionId==='hang')while(true){};state.domain.publicState.count++;return {kind:'accept',state,trace:[],events:[]}},
 project({state,playerIds}){return {sharedView:state.domain.publicState,seats:Object.fromEntries(playerIds.map(id=>[id,{view:state.domain.privateState[id]}]))}},
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
    alice: { view: { secret: "A" } },
  });
  expect(result.switched.projection.seats).toEqual({
    bob: { view: { secret: "B" } },
  });
  expect(result.resumed.projection.sharedView).toEqual({ count: 2 });
  expect(result.reset.projection.sharedView).toEqual({ count: 0 });
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
  expect(result.reset.projection.sharedView).toEqual({ count: 0 });
  expect(await page.locator("iframe").count()).toBe(0);
});
test("opaque worker cannot access storage or network", async ({ page }) => {
  const malicious = source.replace(
    "initialize(){return",
    `async initialize(){
 let storage=false,network=false;
 try{await indexedDB.open('parent-private');storage=true}catch{}
 try{await fetch('http://localhost:4199/secret',{credentials:'include'});network=true}catch{}
 if(storage||network)throw new Error('Isolation failed');
 return`,
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
  expect(result.projection.sharedView).toEqual({ count: 0 });
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
  expect(result.snapshot.projection.sharedView).toEqual({ count: 0 });
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
      "view:state.domain.privateState[id]",
      "view:{...state.domain.publicState,...state.domain.privateState[id],imageUrl:'https://images.test/card'},availableInteractionRefs:[],zones:{}",
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
