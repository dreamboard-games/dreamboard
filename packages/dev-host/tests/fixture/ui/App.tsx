import { createGameUiContract } from "@dreamboard-games/sdk/runtime/workspace-contract";
import game from "../app/game";
const { UI } = createGameUiContract({
  game,
  resourceIds: [],
  resourcePresentationById: {},
  hexStaticBoards: {},
  squareStaticBoards: {},
});
function Counter() {
  const increment = UI.Interaction.useForm("play.increment");
  return (
    <>
      <UI.Game.Root>
        {({ view }) => <h1 className="text-3xl p-4">Count: {view?.count}</h1>}
      </UI.Game.Root>
      <increment.Submit>Increment</increment.Submit>
    </>
  );
}
export default function App() {
  return (
    <UI.Root>
      <Counter />
    </UI.Root>
  );
}
