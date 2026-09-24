import { build } from "esbuild";
const worker = await build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/index.js",
  define: { __WORKER_SOURCE__: JSON.stringify(worker.outputFiles![0]!.text) },
});
