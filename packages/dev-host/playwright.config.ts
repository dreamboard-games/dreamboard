import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { channel: process.env.CI ? undefined : "chrome" },
  workers: 1,
});
