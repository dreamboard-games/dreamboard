import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startDevHost } from "../dist/index.js";
test("launcher bundles authored sources and boots SDK UI without a backend", async ({
  page,
  context,
}) => {
  const host = await startDevHost({
    projectRoot: fileURLToPath(new URL("./fixture", import.meta.url)),
    port: 0,
  });
  try {
    await page.goto(host.url);
    await expect(page.locator("#status")).toHaveText(
      "Local play",
    );
    await expect(
      page.frameLocator('iframe[title="Game"]').getByRole("heading"),
    ).toHaveText("Count: 0");
    await expect(
      page.frameLocator('iframe[title="Game"]').getByRole("heading"),
    ).toHaveCSS("padding", "16px");
    await context.setOffline(true);
    await page
      .frameLocator('iframe[title="Game"]')
      .getByRole("button", { name: "Increment", exact: true })
      .click();
    await expect(
      page.frameLocator('iframe[title="Game"]').getByRole("heading"),
    ).toHaveText("Count: 1");
    await page.locator("#seat").selectOption("player-2");
    await expect(
      page.frameLocator('iframe[title="Game"]').getByRole("heading"),
    ).toHaveText("Count: 1");
    await page.getByRole("button", { name: "Reset game" }).click();
    await expect(page.locator("#status")).toHaveText(
      "Local play",
    );
    await expect(page.locator("#error")).toBeEmpty();
  } finally {
    await page.close();
    await host.close();
  }
});
