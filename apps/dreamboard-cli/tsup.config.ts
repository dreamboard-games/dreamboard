import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/internal.ts",
    "src/authoring-compatibility-internal.ts",
  ],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __DREAMBOARD_BUILD_CHANNEL__: JSON.stringify(
      process.env.DREAMBOARD_BUILD_CHANNEL ?? "development",
    ),
  },
  noExternal: [
    "@dreamboard-games/api-client",
    "@dreamboard-games/cli-core",
    "@dreamboard-games/gameplay-authority-client",
    "citty",
    "consola",
    "picocolors",
    "zod",
  ],
  external: [
    "@dreamboard-games/sdk",
    "@napi-rs/keyring",
    "esbuild",
    "playwright",
    "playwright-core",
    "chromium-bidi",
    "electron",
  ],
});
