import type { RuntimeJson } from "@dreamboard-games/sdk";
import {
  createBrowserGameplayRuntime,
  mountGameplayUI,
  type SavedGame,
} from "@dreamboard-games/browser-gameplay-runtime";
const errorElement = document.querySelector<HTMLDivElement>("#error")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
function report(error: unknown) {
  errorElement.textContent = String(error);
  status.textContent = "Needs attention";
}
async function main() {
  const response = await fetch("/project.json");
  if (!response.ok) throw new Error(await response.text());
  const project = (await response.json()) as {
    reducerSource: string;
    uiHtml: string;
    revision: string;
    playerIds: string[];
    seed: number;
    options: Record<string, RuntimeJson>;
  };
  const storageKey = `dreamboard:local:${project.revision}:${project.seed}:${project.playerIds.join(",")}:${JSON.stringify(project.options)}`;
  const previous = localStorage.getItem(storageKey);
  const runtime = createBrowserGameplayRuntime({
    reducerSource: project.reducerSource,
    initialize: {
      table: {},
      playerIds: project.playerIds,
      rngSeed: project.seed,
      options: project.options,
    },
    restored: previous ? (JSON.parse(previous) as SavedGame) : undefined,
    persist: async (game) => {
      localStorage.setItem(storageKey, JSON.stringify(game));
    },
  });
  const initialSnapshot = await runtime.start();
  const ui = mountGameplayUI({
    container: document.body,
    html: project.uiHtml,
    runtime,
    initialSnapshot,
    sessionId: project.revision,
    players: project.playerIds.map((playerId) => ({
      playerId,
      displayName: playerId,
    })),
    onError: report,
    onSnapshot: (snapshot) => {
      errorElement.textContent = "";
      status.textContent = snapshot.terminal ? "Game ended" : "Local play";
    },
  });
  const seats = document.querySelector<HTMLSelectElement>("#seat")!;
  for (const playerId of project.playerIds) {
    const option = document.createElement("option");
    option.value = playerId;
    option.textContent = playerId;
    seats.append(option);
  }
  seats.onchange = () => {
    void ui.selectSeat(seats.value).catch(report);
  };
  document.querySelector<HTMLButtonElement>("#reset")!.onclick = () => {
    void ui.reset().catch(report);
  };
  const restore = document.querySelector<HTMLButtonElement>("#restore")!;
  restore.disabled = localStorage.getItem(`${storageKey}:checkpoint`) === null;
  document.querySelector<HTMLButtonElement>("#checkpoint")!.onclick = () => {
    void ui
      .checkpoint()
      .then((checkpoint) => {
        localStorage.setItem(
          `${storageKey}:checkpoint`,
          JSON.stringify(checkpoint),
        );
        restore.disabled = false;
      })
      .catch(report);
  };
  restore.onclick = () => {
    const checkpoint = localStorage.getItem(`${storageKey}:checkpoint`);
    if (checkpoint) void ui.restore(JSON.parse(checkpoint)).catch(report);
  };
  addEventListener(
    "pagehide",
    () => {
      ui.dispose();
      runtime.dispose();
    },
    { once: true },
  );
}
void main().catch(report);
