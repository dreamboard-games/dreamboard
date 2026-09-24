import { useState } from "react";
import { createRoot } from "react-dom/client";
import { iframeSource } from "@dreamboard-games/sdk";
import App, { GameProvider } from "./App";
import "./style.css";
const source = iframeSource();
function Shell() {
  const [error, setError] = useState<string | null>(null);
  return (
    <GameProvider source={source} onError={(error) => setError(error.message)}>
      <App />
      {error && <p role="alert">{error}</p>}
    </GameProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Shell />);
