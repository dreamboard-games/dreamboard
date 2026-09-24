import {
  materializePluginGameplayFrame,
  encodeCanonicalPluginRuntimeJson,
  type SubmitInteractionCommand,
  type CancelInteractionCommand,
  type InteractionResult,
  type PluginGameplayFrame,
  type PluginPlayerSummary,
} from "@dreamboard-games/sdk";
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
  // This mount owns one source/session. Seat remounts retain command identity;
  // reset starts a new session history. The serial queue also orders retries.
  const commands = new Map<
    string,
    { identity: string; result?: InteractionResult }
  >();
  function reportError(error: unknown) {
    try {
      options.onError?.(error);
    } catch {
      /* Reporting cannot undo a commit. */
    }
  }
  function notify(run: () => unknown) {
    try {
      run();
    } catch (error) {
      reportError(error);
    }
  }
  async function execute(
    command: SubmitInteractionCommand | CancelInteractionCommand,
  ): Promise<InteractionResult> {
    const identity = encodeCanonicalPluginRuntimeJson(command);
    const recorded = commands.get(command.clientActionId);
    if (recorded) {
      if (
        recorded.identity !== identity ||
        command.basis.perspectivePlayerId !== snapshot.playerId
      )
        throw new Error(
          "Command ID was already used for a different request or seat",
        );
      if (recorded.result) return recorded.result;
    }
    commands.set(command.clientActionId, { identity });
    if (
      encodeCanonicalPluginRuntimeJson(command.basis) !==
      encodeCanonicalPluginRuntimeJson(frame.basis)
    )
      throw new Error("The view changed; try again");
    const actor = command.basis.perspectivePlayerId;
    const dispatched = await options.runtime.dispatch(
      command.type === "interaction.submit"
        ? {
            kind: "interaction",
            playerId: actor,
            interactionId: command.interactionId,
            params: command.params,
          }
        : {
            kind: "interaction.cancel",
            playerId: actor,
            interactionId: command.interactionId,
          },
    );
    const result: InteractionResult =
      dispatched.kind === "accept"
        ? {
            type: "interaction.result",
            clientActionId: command.clientActionId,
            accepted: true,
          }
        : {
            type: "interaction.result",
            clientActionId: command.clientActionId,
            accepted: false,
            errorCode: dispatched.errorCode,
            message: dispatched.message,
          };
    // Dispatch has persisted the commit. Record it before presentation callbacks.
    commands.set(command.clientActionId, { identity, result });
    if (dispatched.kind === "accept") updateSnapshot(dispatched.snapshot);
    return result;
  }
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
    notify(() => options.onSnapshot?.(next));
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
    mountedBridge.onPluginMessage("runtime.resume", () => {
      void queue(async () => {
        if (mountedBridge === bridge) mountedBridge.sendGameplayFrame(frame);
      }).catch(reportError);
    });
    const receiveCommand = (
      incoming: SubmitInteractionCommand | CancelInteractionCommand,
    ) => {
      const command = structuredClone(incoming);
      const requester = mountedBridge;
      void queue(async () => {
        // A command queued by a retired seat/source must never receive or mutate
        // the newly selected seat, including through a cached result.
        if (requester !== bridge) return;
        let result: InteractionResult;
        try {
          result = await execute(command);
        } catch (error) {
          result = {
            type: "interaction.result",
            clientActionId: command.clientActionId,
            accepted: false,
            errorCode: "local_execution_failed",
            message: String(error),
          };
          reportError(error);
        }
        if (!disposed && requester === bridge) {
          notify(() => requester.sendGameplayFrame(frame));
          notify(() => requester.sendSubmitResult(result));
        }
      }).catch(reportError);
    };
    mountedBridge.onPluginMessage("interaction.submit", receiveCommand);
    mountedBridge.onPluginMessage("interaction.cancel", receiveCommand);
    iframe.onload = () => {
      const sendInit = () => {
        if (++attempts > 40) {
          stopHandshake();
          options.onError?.(
            new Error("Game UI did not initialize within 10 seconds"),
          );
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
    checkpoint: () => queue(() => options.runtime.checkpoint()),
    restore: (checkpoint: unknown) => {
      const original = structuredClone(checkpoint);
      return queue(async () => {
        const next = await options.runtime.restore(original);
        commands.clear();
        if (!disposed) {
          stopHandshake();
          bridge.disconnect();
          iframe.remove();
          updateSnapshot(next);
          mount();
        }
        return next;
      });
    },
    reset: () =>
      queue(async () => {
        const next = await options.runtime.reset();
        commands.clear();
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
