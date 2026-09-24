import { defineConfig } from "@playwright/test";
export default defineConfig({
  workers: 1,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        channel: process.env.CI ? undefined : "chrome",
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
