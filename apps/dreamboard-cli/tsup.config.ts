import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    internal: "src/internal.ts",
    "authoring-release-set": "src/release/authoring-release-set.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: true,
  dts: {
    entry: {
      "authoring-release-set": "src/release/authoring-release-set.ts",
    },
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __DREAMBOARD_BUILD_CHANNEL__: JSON.stringify(
      process.env.DREAMBOARD_BUILD_CHANNEL ?? "development",
    ),
    __DREAMBOARD_PACKAGE_VERSION__: JSON.stringify(
      process.env.AUTHORING_CLI_CANDIDATE_VERSION ??
        packageJson.version ??
        "0.0.0-development",
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
