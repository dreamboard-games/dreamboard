export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type RevisionDigestInput = {
  sourceTreeHash: string;
  ruleContentHash: string;
  manifestContentHash: string;
};

const textEncoder = new TextEncoder();

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export async function computeRevisionDigest(
  input: RevisionDigestInput,
): Promise<`sha256:${string}`> {
  const canonical = canonicalJson({
    format: "dreamboard.game-revision/v1",
    sourceTreeHash: input.sourceTreeHash,
    ruleContentHash: input.ruleContentHash,
    manifestContentHash: input.manifestContentHash,
  });
  return `sha256:${await sha256Hex(textEncoder.encode(canonical))}`;
}

function canonicalize(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("JSON integer values must be safe JavaScript integers");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalizedBytes.buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
