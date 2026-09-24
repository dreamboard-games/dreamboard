#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startDevHost } from "./index.js";
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5173" },
    players: { type: "string", default: "2" },
    seed: { type: "string", default: "1" },
    help: { type: "boolean" },
  },
});
if (values.help)
  console.log(
    "dreamboard-dev [--port 5173] [--players 2] [--seed 1]\nRun from a game project containing manifest.ts, app/game.ts, and ui/App.tsx.",
  );
else {
  const host = await startDevHost({
    projectRoot: process.cwd(),
    port: Number(values.port),
    players: Number(values.players),
    seed: Number(values.seed),
  });
  console.log(`Dreamboard local play: ${host.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void host.close().then(() => process.exit(0));
    });
}
