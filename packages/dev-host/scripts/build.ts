import { build } from "esbuild";
await build({
  entryPoints: ["src/host.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "dist/host.js",
});
await build({
  entryPoints: ["src/index.ts", "src/cli.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outdir: "dist",
});
await build({
  entryPoints: ["src/seeded-shuffle.ts"],
  platform: "browser",
  format: "esm",
  outdir: "dist",
});
