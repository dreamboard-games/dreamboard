import { createGameHook } from "@dreamboard-games/sdk/react";
import type game from "../app/game";
export const { GameProvider, useGame } = createGameHook<typeof game>()({
  coverage: { "play.increment": App, "play.choose": App },
});
export default function App() {
  const snapshot = useGame((game) => game);
  const increment = snapshot.interactions.get("play.increment");
  const choose = snapshot.interactions.get("play.choose");
  const first = choose?.getInput("choice");
  const second = choose?.getInput("confirm");
  return (
    <main>
      <h1 className="text-3xl p-4">Count: {snapshot.view?.count}</h1>
      <p>Private: {snapshot.view?.secret}</p>
      <p>Roll: {snapshot.view?.roll ?? "none"}</p>
      {increment && <button {...increment.getSubmitProps()}>Increment</button>}
      {choose && (
        <section aria-label="Committed choice">
          <p>Step {(choose.getStep()?.index ?? 0) + 1}</p>
          {first && (
            <>
              <button onClick={() => first.setValue("accept")}>
                Choose accept
              </button>
              <button onClick={() => first.setValue("reject")}>
                Choose reject
              </button>
            </>
          )}
          {second && (
            <button onClick={() => second.setValue(null)}>Choose null</button>
          )}
          <button {...choose.getSubmitProps()}>Continue</button>
          {choose.getStep()?.canCancel && (
            <button
              disabled={choose.getStatus() !== "open"}
              onClick={() => {
                void choose
                  .cancel()
                  .catch((error) => choose.game.getOptions().onError?.(error));
              }}
            >
              Cancel choice
            </button>
          )}
        </section>
      )}
    </main>
  );
}
