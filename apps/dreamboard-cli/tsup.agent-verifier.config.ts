import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/agent-verifier/agent-workspace-verifier.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist/agent-verifier",
  clean: true,
  sourcemap: true,
  splitting: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __DREAMBOARD_BUILD_CHANNEL__: JSON.stringify("development"),
  },
  outExtension() {
    return { js: ".mjs" };
  },
  noExternal: [
    "@dreamboard-games/api-client",
    "@dreamboard-games/gameplay-authority-client",
    "citty",
    "clsx",
    "consola",
    "lucide-react",
    "picocolors",
    "postcss",
    "sonner",
    "tailwind-merge",
    "tw-animate-css",
    "zod",
    "zustand",
  ],
  external: [
    "@dreamboard-games/sdk",
    "@dreamboard-games/ui-host-runtime",
    "@napi-rs/keyring",
    "esbuild",
    "playwright",
    "playwright-core",
    "chromium-bidi",
    "electron",
    "react",
    "react-dom",
    "tailwindcss",
    "vaul",
    "vite",
  ],
});
