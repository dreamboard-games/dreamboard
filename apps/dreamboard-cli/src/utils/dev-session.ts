import { randomInt } from "node:crypto";
import { exists, readJsonFile } from "./fs.js";

export type PersistedDevSession = {
  sessionId: string;
};

const DEFAULT_DEV_SEED = 1337;
const MAX_RANDOM_DEV_SEED_EXCLUSIVE = 2_147_483_648;
const MIN_KOTLIN_LONG = -9_223_372_036_854_775_808n;
const MAX_KOTLIN_LONG = 9_223_372_036_854_775_807n;
const MIN_SAFE_SEED = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_SEED = BigInt(Number.MAX_SAFE_INTEGER);

export function createPersistedDevSession(input: {
  sessionId: string;
}): PersistedDevSession {
  return {
    sessionId: input.sessionId,
  };
}

export async function loadPersistedDevSession(
  sessionFilePath: string,
): Promise<PersistedDevSession | null> {
  if (!(await exists(sessionFilePath))) {
    return null;
  }
  const value = await readJsonFile<PersistedDevSession>(sessionFilePath);
  if (!value.sessionId) {
    return null;
  }
  return {
    sessionId: value.sessionId,
  };
}

export function parseDevSeed(rawSeed: string | undefined): number {
  return parseOptionalDevSeed(rawSeed) ?? DEFAULT_DEV_SEED;
}

export function parseOptionalDevSeed(
  rawSeed: string | undefined,
): number | undefined {
  const value = rawSeed?.trim();
  if (!value) {
    return undefined;
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error("seed must be an integer");
  }

  const parsed = BigInt(value);
  if (parsed < MIN_KOTLIN_LONG || parsed > MAX_KOTLIN_LONG) {
    throw new Error("seed must be within signed 64-bit integer range");
  }
  if (parsed < MIN_SAFE_SEED || parsed > MAX_SAFE_SEED) {
    throw new Error(
      `seed must be within JavaScript safe integer range (${Number.MIN_SAFE_INTEGER}..${Number.MAX_SAFE_INTEGER})`,
    );
  }

  return Number(parsed);
}

export function generateRandomDevSeed(): number {
  return randomInt(MAX_RANDOM_DEV_SEED_EXCLUSIVE);
}
