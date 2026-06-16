import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function copyDirectory(relativePath: string): Promise<void> {
  const source = path.join(packageRoot, "src", relativePath);
  const target = path.join(packageRoot, "dist", relativePath);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

await copyDirectory("dev-host");
await copyDirectory("scaffold/assets/static");
