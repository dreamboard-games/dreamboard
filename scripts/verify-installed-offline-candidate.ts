import { spawn, execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
const root = path.resolve(import.meta.dirname, "..");
const candidate = path.join(root, "build/release-candidate");
const receipt = JSON.parse(
  await readFile(path.join(candidate, "receipt.json"), "utf8"),
);
const project = await mkdtemp(
  path.join(tmpdir(), "dreamboard-installed-offline-"),
);
const runtime = receipt.packages.find(
  (entry: { name: string }) =>
    entry.name === "@dreamboard-games/browser-gameplay-runtime",
);
const host = receipt.packages.find(
  (entry: { name: string }) => entry.name === "@dreamboard-games/dev-host",
);
const runtimeFile = path.join(candidate, runtime.file);
const runtimeOverride = `${runtime.name}@${runtime.version}`;
await cp(path.join(root, "packages/dev-host/tests/fixture"), project, {
  recursive: true,
});
await writeFile(
  path.join(project, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    packageManager: "pnpm@10.4.1",
    pnpm: { overrides: { [runtimeOverride]: `file:${runtimeFile}` } },
    dependencies: {
      "@dreamboard-games/dev-host": `file:${path.join(candidate, host.file)}`,
      "@dreamboard-games/browser-gameplay-runtime": `file:${runtimeFile}`,
      "@dreamboard-games/sdk": receipt.sdkVersion,
      "@tanstack/react-store": "0.11.1",
      react: "19.2.7",
      "react-dom": "19.2.7",
      zod: "4.4.3",
      tailwindcss: "4.3.3",
    },
  }),
);
// Candidate tarballs are a test-owned transport outside the workspace. Product
// consumers still install the public npm versions after an approved release.
await writeFile(
  path.join(project, "pnpm-workspace.yaml"),
  `packages: []\noverrides:\n  ${JSON.stringify(runtimeOverride)}: ${JSON.stringify(`file:${runtimeFile}`)}\n`,
);
await writeFile(
  path.join(project, ".npmrc"),
  "registry=https://registry.npmjs.org/\n@dreamboard-games:registry=https://registry.npmjs.org/\n",
);
try {
  execFileSync("pnpm", ["install", "--ignore-scripts"], {
    cwd: project,
    stdio: "pipe",
  });
} catch (error) {
  throw new Error(
    `Candidate consumer installation failed: ${String((error as { stderr?: unknown }).stderr)}`,
  );
}
const child = spawn(
  process.execPath,
  [
    path.join(project, "node_modules/@dreamboard-games/dev-host/dist/cli.js"),
    "--port",
    "0",
  ],
  { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
);
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Installed launcher did not start")),
      10000,
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Installed launcher exited: ${code}`)),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
  });
  for (const name of ["chromium", "webkit"] as const) {
    const browser = await (name === "chromium" ? chromium : webkit).launch(
      name === "chromium" && !process.env.CI ? { channel: "chrome" } : {},
    );
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const game = page.frameLocator('iframe[title="Game"]');
      await expect(game.getByRole("heading")).toHaveText("Count: 0");
      await expect(game.getByRole("heading")).toHaveCSS("padding", "16px");
      await context.setOffline(true);
      await game
        .getByRole("button", { name: "Increment", exact: true })
        .click();
      await expect(game.getByRole("heading")).toHaveText("Count: 1");
      await page.locator("#seat").selectOption("player-2");
      await expect(game.getByRole("heading")).toHaveText("Count: 1");
      await page
        .getByRole("button", { name: "Reset game", exact: true })
        .click();
      await expect(game.getByRole("heading")).toHaveText("Count: 0");
      await expect(page.locator("#error")).toBeEmpty();
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    path.join(candidate, "installed-proof.json"),
    JSON.stringify(
      {
        sourceCommit: receipt.sourceCommit,
        sdkVersion: receipt.sdkVersion,
        packages: receipt.packages,
        project,
        browsers: ["chromium", "webkit"],
        checks: [
          "installed launcher",
          "compiled fixture",
          "authored stylesheet and Tailwind",
          "offline SDK submission",
          "seat switch",
          "reset",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Installed candidate launcher, CSS, offline SDK submit, seat switch, and reset passed in Chromium and WebKit.",
  );
} finally {
  child.kill("SIGTERM");
}
