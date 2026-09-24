import {
  materializePluginGameplayFrame,
  type PluginGameplayFrame,
  type PluginPlayerSummary,
} from "@dreamboard-games/sdk/plugin-runtime-contract";
import type { BrowserGameplayRuntime, GameplaySnapshot } from "./index.js";
import { PluginBridge } from "./plugin-bridge.js";
export interface GameplayUIOptions {
  container: HTMLElement;
  html: string;
  assets?: Readonly<Record<string, string>>;
  runtime: BrowserGameplayRuntime;
  initialSnapshot: GameplaySnapshot;
  sessionId: string;
  players: readonly PluginPlayerSummary[];
  onSnapshot?: (snapshot: GameplaySnapshot) => void;
  onError?: (error: unknown) => void;
}
const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
/** Mounts authored UI independently from the reducer sandbox. The caller owns
 * runtime lifetime; disposing this adapter removes only its UI and bridge. */
export function mountGameplayUI(options: GameplayUIOptions) {
  let snapshot = options.initialSnapshot;
  let version = 0;
  let frame: PluginGameplayFrame;
  let bridge: PluginBridge;
  let iframe: HTMLIFrameElement;
  let disposed = false;
  let stopHandshake = () => {};
  let tail: Promise<unknown> = Promise.resolve();
  function queue<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(() => {
      if (disposed) throw new Error("Game UI disposed");
      return run();
    });
    tail = result.catch(() => {});
    return result;
  }
  function updateSnapshot(next: GameplaySnapshot) {
    if (disposed) return;
    snapshot = next;
    version++;
    frame = materializePluginGameplayFrame({
      currentPhase: next.currentPhase,
      activePlayers: next.activePlayers,
      dynamicProjection: next.projection,
      staticProjection: next.boardStatic,
      perspectivePlayerId: next.playerId,
      version,
      actionSetVersion: `${options.sessionId}:${version}`,
    });
    if (options.assets) {
      const replaceAssets = <T>(value: T): T =>
        JSON.parse(
          JSON.stringify(value, (_key, value) =>
            typeof value === "string"
              ? (options.assets?.[value] ?? value)
              : value,
          ),
        );
      frame = {
        ...frame,
        view: replaceAssets(frame.view),
        zones: Object.fromEntries(
          Object.entries(frame.zones).map(([id, zone]) => [
            id,
            { ...zone, cardViewsById: replaceAssets(zone.cardViewsById) },
          ]),
        ),
      };
    }
    options.onSnapshot?.(next);
  }
  function mount() {
    iframe = document.createElement("iframe");
    iframe.title = "Game";
    iframe.sandbox.add("allow-scripts");
    iframe.srcdoc = policy + options.html;
    options.container.append(iframe);
    bridge = new PluginBridge(iframe);
    const mountedBridge = bridge;
    let attempts = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const mountedIframe = iframe;
    stopHandshake = () => {
      clearInterval(timer);
      mountedIframe.onload = null;
    };
    bridge.onPluginMessage("runtime.ready", () => {
      stopHandshake();
      mountedBridge.sendGameplayFrame(frame);
    });
    bridge.onPluginMessage("runtime.error", (message) =>
      options.onError?.(new Error(message.message)),
    );
    bridge.onPluginMessage("interaction.submit", (command) => {
      const requester = bridge;
      void queue(async () => {
        try {
          if (
            command.basis.version !== frame.basis.version ||
            command.basis.actionSetVersion !== frame.basis.actionSetVersion ||
            command.basis.perspectivePlayerId !== snapshot.playerId
          )
            throw new Error("The view changed; try again");
          const result = await options.runtime.dispatch({
            kind: "interaction",
            playerId: snapshot.playerId,
            interactionId: command.interactionId,
            params: command.params,
          });
          if (result.kind === "accept") {
            updateSnapshot(result.snapshot);
            if (!disposed) bridge.sendGameplayFrame(frame);
            requester.sendSubmitResult({
              type: "interaction.result",
              clientActionId: command.clientActionId,
              accepted: true,
            });
          } else
            requester.sendSubmitResult({
              type: "interaction.result",
              clientActionId: command.clientActionId,
              accepted: false,
              errorCode: result.errorCode,
              message: result.message,
            });
        } catch (error) {
          requester.sendSubmitResult({
            type: "interaction.result",
            clientActionId: command.clientActionId,
            accepted: false,
            errorCode: "local_execution_failed",
            message: String(error),
          });
          options.onError?.(error);
        }
      }).catch((error) => options.onError?.(error));
    });
    iframe.onload = () => {
      const sendInit = () => {
        if (++attempts > 40) {
          stopHandshake();
          options.onError?.(new Error("Game UI did not initialize within 10 seconds"));
          return;
        }
        mountedBridge.sendInit({
          sessionId: options.sessionId,
          players: options.players,
        });
      };
      timer = setInterval(sendInit, 250);
      sendInit();
    };
  }
  updateSnapshot(snapshot);
  mount();
  return {
    selectSeat: (playerId: string) =>
      queue(async () => {
        const next = await options.runtime.selectSeat(playerId);
        if (!disposed) {
          stopHandshake();
          bridge.disconnect();
          iframe.remove();
          updateSnapshot(next);
          mount();
        }
        return next;
      }),
    reset: () =>
      queue(async () => {
        const next = await options.runtime.reset();
        if (!disposed) {
          stopHandshake();
          bridge.disconnect();
          iframe.remove();
          updateSnapshot(next);
          mount();
        }
        return next;
      }),
    dispose: () => {
      disposed = true;
      stopHandshake();
      bridge.disconnect();
      iframe.remove();
    },
  };
}
