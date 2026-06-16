/**
 * Primitives for safely mutating local state files owned by the CLI.
 *
 * Two guarantees:
 * - Writes are atomic-ish: we stage the payload in a sibling temp file with
 *   the target permissions, fsync the contents, then `rename` over the target.
 *   On POSIX `rename` within the same directory is atomic; on Windows it is
 *   atomic within the same volume which is always the case for files we write
 *   inside `~/.dreamboard`.
 * - We refuse to clobber a file with an empty payload. The original bug that
 *   wiped refresh tokens on a failing `sync`/`compile` hinged on `undefined`
 *   JSON values being persisted and reloaded as `{}`. Forbidding empty
 *   writes here removes that entire failure mode at the primitive level.
 *
 * Additionally, `withFileLock` provides a cross-process advisory lock built on
 * `O_CREAT | O_EXCL` so that parallel CLI invocations (e.g. `dreamboard sync`
 * running while `dreamboard compile` is in flight) serialize around mutations
 * of the same credential state.
 */

import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type AtomicWriteOptions = {
  /** File mode applied to the written file (default: 0o600). */
  mode?: number;
  /** Call `fsync` on the temp file before renaming. Default: true. */
  fsync?: boolean;
};

export async function atomicWriteFile(
  targetPath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  if (contents.length === 0) {
    throw new Error(
      `Refusing to atomicWriteFile an empty payload to ${targetPath}`,
    );
  }
  const mode = options.mode ?? 0o600;
  const shouldFsync = options.fsync ?? true;
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const suffix = crypto.randomBytes(6).toString("hex");
  const tmpPath = `${targetPath}.tmp-${process.pid}-${suffix}`;

  const fh = await fs.open(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    mode,
  );
  try {
    await fh.writeFile(contents, "utf8");
    try {
      await fh.chmod(mode);
    } catch {
      // Some filesystems (e.g. network volumes, Windows) refuse chmod.
      // Ignoring here is safe: the `open` call above already created the
      // file with the requested mode on systems that honor it.
    }
    if (shouldFsync) {
      try {
        await fh.sync();
      } catch {
        // Best-effort. Not all backends (tmpfs on some platforms) support fsync.
      }
    }
  } finally {
    await fh.close();
  }

  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export type FileLockOptions = {
  /** Max number of acquisition attempts before giving up. Default: 100. */
  retries?: number;
  /** Minimum backoff between retries in ms. Default: 20. */
  minDelayMs?: number;
  /** Maximum backoff between retries in ms. Default: 200. */
  maxDelayMs?: number;
  /**
   * A lockfile older than this is considered stale and forcibly removed.
   * Guards against crashed processes leaving a permanent lock. Default: 30s.
   */
  staleMs?: number;
};

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const retries = options.retries ?? 100;
  const minDelayMs = options.minDelayMs ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 200;
  const staleMs = options.staleMs ?? 30_000;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let attempt = 0;
  let acquired = false;
  while (!acquired) {
    try {
      const fh = await fs.open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      await fh.writeFile(`${process.pid}\n`, "utf8");
      await fh.close();
      acquired = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
    }

    let stat: Stats | null = null;
    try {
      stat = await fs.stat(lockPath);
    } catch {
      continue;
    }
    if (stat !== null) {
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > staleMs) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
    }

    attempt += 1;
    if (attempt >= retries) {
      throw new Error(
        `Timed out acquiring file lock at ${lockPath} after ${retries} attempts.`,
      );
    }
    const jitter = Math.floor(
      Math.random() * Math.max(1, maxDelayMs - minDelayMs),
    );
    await new Promise((resolve) => setTimeout(resolve, minDelayMs + jitter));
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}
