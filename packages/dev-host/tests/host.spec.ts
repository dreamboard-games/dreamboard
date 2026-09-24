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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(host.url);
    await expect(page.locator("#status")).toHaveText("Local play");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    expect(
      (await page.locator('iframe[title="Game"]').boundingBox())!.height,
    ).toBeGreaterThan(300);
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
    await expect(page.locator("#status")).toHaveText("Local play");
    await expect(page.locator("#error")).toBeEmpty();
  } finally {
    await page.close();
    await host.close();
  }
});

test("executes the authored reducer entry instead of rebuilding app/game", async ({
  page,
}) => {
  const { cp, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const project = await mkdtemp(
    fileURLToPath(new URL("./entry-proof-", import.meta.url)),
  );
  let host: Awaited<ReturnType<typeof startDevHost>> | undefined;
  try {
    await cp(fileURLToPath(new URL("./fixture", import.meta.url)), project, {
      recursive: true,
    });
    await writeFile(
      join(project, "app/index.ts"),
      `import {createReducerBundle} from '@dreamboard-games/sdk/reducer';
import game from './game';
const bundle=createReducerBundle(game);
export default {...bundle, initialize(){throw new Error('authored reducer entry executed')}};`,
    );
    host = await startDevHost({ projectRoot: project, port: 0 });
    await page.goto(host.url);
    await expect(page.locator("#error")).toContainText(
      "authored reducer entry executed",
    );
  } finally {
    await page.close();
    await host?.close();
    await rm(project, { recursive: true, force: true });
  }
});

test("headless committed choices persist options, reject atomically, cancel and restore JSON checkpoints", async ({
  page,
}) => {
  const host = await startDevHost({
    projectRoot: fileURLToPath(new URL("./fixture", import.meta.url)),
    port: 0,
    seed: 17,
    options: { start: 7 },
  });
  try {
    await page.goto(host.url);
    const ui = () => page.frameLocator('iframe[title="Game"]');
    await expect(ui().getByRole("heading")).toHaveText("Count: 7");
    await ui()
      .getByRole("button", { name: "Choose reject", exact: true })
      .click();
    await ui().getByRole("button", { name: "Continue", exact: true }).click();
    await expect(ui().getByText("Step 2", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Restore checkpoint", exact: true }),
    ).toBeEnabled();
    const before = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(
        (key) =>
          key.startsWith("dreamboard:local:") && !key.endsWith(":checkpoint"),
      )!;
      return localStorage.getItem(key);
    });
    await ui()
      .getByRole("button", { name: "Choose null", exact: true })
      .click();
    await ui().getByRole("button", { name: "Continue", exact: true }).click();
    await expect(ui().getByRole("alert")).toContainText(
      "Choose the accepted option",
    );
    await expect(ui().getByText("Step 2", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find(
          (key) =>
            key.startsWith("dreamboard:local:") && !key.endsWith(":checkpoint"),
        )!;
        return localStorage.getItem(key);
      }),
    ).toBe(before);
    await ui()
      .getByRole("button", { name: "Cancel choice", exact: true })
      .click();
    await expect(ui().getByText("Step 1", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Restore checkpoint", exact: true })
      .click();
    await expect(ui().getByText("Step 2", { exact: true })).toBeVisible();
    await page.reload();
    await expect(ui().getByText("Step 2", { exact: true })).toBeVisible();
    await expect(ui().getByRole("heading")).toHaveText("Count: 7");
    await ui()
      .getByRole("button", { name: "Cancel choice", exact: true })
      .click();
    await ui()
      .getByRole("button", { name: "Choose accept", exact: true })
      .click();
    await ui().getByRole("button", { name: "Continue", exact: true }).click();
    await ui()
      .getByRole("button", { name: "Choose null", exact: true })
      .click();
    await ui().getByRole("button", { name: "Continue", exact: true }).click();
    await expect(ui().getByRole("heading")).toHaveText("Count: 8");
    const saved = JSON.parse(
      (await page.evaluate(() => {
        const key = Object.keys(localStorage).find(
          (key) =>
            key.startsWith("dreamboard:local:") && !key.endsWith(":checkpoint"),
        )!;
        return localStorage.getItem(key);
      }))!,
    );
    expect(saved.state.runtime.options).toEqual({ start: 7 });
    expect(saved.state.runtime.pending).toEqual({});
    expect(saved.state.runtime.rng.cursor).toBe(1);
    expect(saved.state.runtime.events).toEqual([
      { kind: "systemAction", procedureId: "choose", title: "Choice accepted" },
    ]);
    await page.locator("#seat").selectOption("player-2");
    await expect(
      ui().getByText("Private: secret-player-2", { exact: true }),
    ).toBeVisible();
    await expect(ui().locator("body")).not.toContainText("secret-player-1");
    await expect(ui().locator("body")).not.toContainText("host-only");
  } finally {
    await page.close();
    await host.close();
  }
});
