import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  resolveWorkspacePath,
  writeWorkspaceTextFile,
} from "./workspace-path.js";

test("resolveWorkspacePath rejects traversal, absolute paths, and encoded separators", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-workspace-path-"));

  try {
    const unsafePaths = [
      "../escape.ts",
      "app/../../escape.ts",
      "/tmp/escape.ts",
      "C:/tmp/escape.ts",
      "app/%2f/escape.ts",
      "app/%5c/escape.ts",
    ];

    for (const unsafePath of unsafePaths) {
      expect(() => resolveWorkspacePath(tempRoot, unsafePath)).toThrow(
        "Unsafe project path",
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveWorkspacePath allows owned relative paths inside the workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-workspace-path-"));

  try {
    expect(resolveWorkspacePath(tempRoot, "app/game.ts")).toBe(
      path.join(tempRoot, "app", "game.ts"),
    );
    await writeWorkspaceTextFile(tempRoot, "ui/components/Panel.tsx", "ok");
    expect(
      await readFile(path.join(tempRoot, "ui", "components", "Panel.tsx"), {
        encoding: "utf8",
      }),
    ).toBe("ok");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace writes reject symlink parent escapes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "db-workspace-path-"));
  const outsideRoot = await mkdtemp(
    path.join(os.tmpdir(), "db-workspace-outside-"),
  );

  try {
    await mkdir(path.join(tempRoot, "real"), { recursive: true });
    await symlink(outsideRoot, path.join(tempRoot, "app"));

    await expect(
      writeWorkspaceTextFile(tempRoot, "app/escape.ts", "nope"),
    ).rejects.toThrow("escapes the workspace");
    await expect(
      readFile(path.join(outsideRoot, "escape.ts"), { encoding: "utf8" }),
    ).rejects.toThrow();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
