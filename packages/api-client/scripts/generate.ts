import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dir, "..");
const generatedDirectories = ["src/@tanstack", "src/client", "src/core"];
await Promise.all(
  generatedDirectories.map((relativePath) =>
    mkdir(path.join(packageRoot, relativePath), { recursive: true }),
  ),
);

const command = Bun.spawn(["pnpm", "exec", "openapi-ts"], {
  cwd: packageRoot,
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await command.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

async function rewriteRelativeImportSpecifiersToJs(
  directory: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await rewriteRelativeImportSpecifiersToJs(entryPath);
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return;
      }

      const original = await readFile(entryPath, "utf8");
      const resolveSpecifier = (specifier: string): string => {
        if (/\.(?:[cm]?js|[cm]?ts|json|css)$/.test(specifier)) {
          return specifier;
        }

        const resolvedPath = path.resolve(path.dirname(entryPath), specifier);
        if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
          if (
            existsSync(path.join(resolvedPath, "index.ts")) ||
            existsSync(path.join(resolvedPath, "index.js"))
          ) {
            return `${specifier}/index.js`;
          }
        }

        return `${specifier}.js`;
      };
      const patched = original.replace(
        /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
        (full, prefix, specifier, suffix) =>
          `${prefix}${resolveSpecifier(specifier)}${suffix}`,
      );

      if (patched !== original) {
        await Bun.write(entryPath, patched);
      }
    }),
  );
}

await rewriteRelativeImportSpecifiersToJs(path.join(packageRoot, "src"));

async function patchChoiceDomainOptionNullability(): Promise<void> {
  const replacements: Array<[string, Array<[RegExp, string]>]> = [
    [
      "src/types.gen.ts",
      [
        [
          /export type ChoiceDomainOption = \{\n    value: string;/,
          "export type ChoiceDomainOption = {\n    value: string | null;",
        ],
      ],
    ],
    [
      "src/zod.gen.ts",
      [
        [
          /export const zChoiceDomainOption = z\.object\(\{\n    value: z\.string\(\),/,
          "export const zChoiceDomainOption = z.object({\n    value: z.nullable(z.string()),",
        ],
      ],
    ],
  ];

  for (const [relativePath, fileReplacements] of replacements) {
    const target = path.join(packageRoot, relativePath);
    let content = await readFile(target, "utf8");
    for (const [pattern, replacement] of fileReplacements) {
      content = content.replace(pattern, replacement);
    }
    await Bun.write(target, content);
  }
}

await patchChoiceDomainOptionNullability();

const targetDir = path.join(packageRoot, "src", "core");
await mkdir(targetDir, { recursive: true });
await cp(
  path.join(packageRoot, "serverSentEvents.ts"),
  path.join(targetDir, "serverSentEvents.gen.ts"),
  { force: true },
);

await Bun.write(
  path.join(packageRoot, "src", "storage-paths.ts"),
  `/**
 * Storage path constants shared between frontend and backend.
 * These mirror the values in the Kotlin StoragePathUtils.
 */

/**
 * Storage bucket for compiled scripts (game logic and UI bundles)
 */
export const STORAGE_BUCKET = "scripts";

/**
 * Directory name for source files
 */
export const SOURCE_DIR = "src";

/**
 * Directory name for compiled output
 */
export const DIST_DIR = "dist";
`,
);

await Bun.write(
  path.join(packageRoot, "src", "source-revisions.ts"),
  `import { createProjectSourceBlobUploadSession } from "./sdk.gen.js";
import type {
  SourceBlobUploadDescriptor,
  SourceBlobUploadSession,
  SourceBlobUploadTarget,
  SourceChangeOperation,
} from "./types.gen.js";

export type SourceContentChangeOperation =
  | {
      kind: "upsert";
      path: string;
      content: string;
    }
  | {
      kind: "delete";
      path: string;
    };

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalizedBytes.buffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

function getUtf8ByteSize(content: string): number {
  return textEncoder.encode(content).byteLength;
}

async function computeSourceContentHash(content: string): Promise<string> {
  return sha256Hex(textEncoder.encode(content));
}

async function describeSourceBlob(
  content: string,
): Promise<SourceBlobUploadDescriptor> {
  return {
    contentHash: await computeSourceContentHash(content),
    byteSize: getUtf8ByteSize(content),
  };
}

export async function materializeSourceChangeOperations(
  changes: Iterable<SourceContentChangeOperation>,
): Promise<{
  blobs: SourceBlobUploadDescriptor[];
  changes: SourceChangeOperation[];
}> {
  const blobsByHash = new Map<string, SourceBlobUploadDescriptor>();
  const materialized = await Promise.all(
    Array.from(changes, async (change): Promise<SourceChangeOperation> => {
      if (change.kind === "delete") {
        return change;
      }

      const blob = await describeSourceBlob(change.content);
      const existing = blobsByHash.get(blob.contentHash);
      if (!existing) {
        blobsByHash.set(blob.contentHash, blob);
      }

      return {
        kind: "upsert",
        path: change.path,
        contentHash: blob.contentHash,
        byteSize: blob.byteSize,
      };
    }),
  );

  return {
    blobs: Array.from(blobsByHash.values()).sort((left, right) =>
      left.contentHash.localeCompare(right.contentHash),
    ),
    changes: materialized,
  };
}

export type SourceBlobUploadInput = SourceBlobUploadDescriptor & {
  content: string;
};

export function mapUpsertBlobContentsByContentHash(
  localChanges: readonly SourceContentChangeOperation[],
  materializedChanges: readonly SourceChangeOperation[],
): Map<string, SourceBlobUploadInput> {
  const uploadBlobs = new Map<string, SourceBlobUploadInput>();
  const length = Math.min(localChanges.length, materializedChanges.length);
  for (let index = 0; index < length; index += 1) {
    const localChange = localChanges[index];
    const materializedChange = materializedChanges[index];
    if (
      localChange?.kind !== "upsert" ||
      materializedChange?.kind !== "upsert"
    ) {
      continue;
    }

    uploadBlobs.set(materializedChange.contentHash, {
      contentHash: materializedChange.contentHash,
      byteSize: materializedChange.byteSize,
      content: localChange.content,
    });
  }

  return uploadBlobs;
}

class SourceBlobUploadError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, details: string) {
    const suffix = details.trim().length > 0 ? \`: \${details.trim()}\` : "";
    super(\`Failed to upload source blob (HTTP \${status}\${suffix})\`);
    this.name = "SourceBlobUploadError";
    this.status = status;
    this.details = details;
  }
}

function isDuplicateDirectUploadError(
  error: unknown,
): error is SourceBlobUploadError {
  if (!(error instanceof SourceBlobUploadError)) {
    return false;
  }

  if (error.status === 409) {
    return true;
  }

  const normalizedDetails = error.details.toLowerCase();
  return (
    normalizedDetails.includes("duplicate") ||
    normalizedDetails.includes("already exists") ||
    normalizedDetails.includes("resource already exists")
  );
}

async function uploadSourceBlob(
  uploadTarget: SourceBlobUploadTarget,
  content: string,
): Promise<void> {
  const response = await fetch(uploadTarget.url, {
    method: uploadTarget.method,
    headers: uploadTarget.headers,
    body: textEncoder.encode(content),
  });

  if (response.ok) {
    return;
  }

  const details = await response.text().catch(() => "");
  throw new SourceBlobUploadError(response.status, details);
}

export class SourceBlobSessionRequestError extends Error {
  readonly apiError: unknown;
  readonly response: Response | undefined;

  constructor(
    message: string,
    apiError: unknown,
    response: Response | undefined,
  ) {
    super(message);
    this.name = "SourceBlobSessionRequestError";
    this.apiError = apiError;
    this.response = response;
  }
}

function assertSourceBlobUploadSession(
  data: unknown,
  response: Response | undefined,
): asserts data is SourceBlobUploadSession {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { uploads?: unknown }).uploads)
  ) {
    throw new SourceBlobSessionRequestError(
      "Source blob upload session response did not include an uploads array",
      data,
      response,
    );
  }
}

type SourceBlobUploadSessionRequester = (
  blobs: SourceBlobUploadDescriptor[],
) => Promise<{
  data: unknown;
  error: unknown;
  response: Response | undefined;
}>;

async function confirmSourceBlobAlreadyExists(options: {
  requestUploadSession: SourceBlobUploadSessionRequester;
  blob: SourceBlobUploadInput;
}): Promise<boolean> {
  const { requestUploadSession, blob } = options;
  const { data, error, response } = await requestUploadSession([
    {
      contentHash: blob.contentHash,
      byteSize: blob.byteSize,
    },
  ]);

  if (error || !data) {
    throw new SourceBlobSessionRequestError(
      "Failed to create source blob upload session",
      error,
      response,
    );
  }
  assertSourceBlobUploadSession(data, response);

  return data.uploads[0]?.status === "exists";
}

async function uploadSourceBlobs(options: {
  blobs: SourceBlobUploadInput[];
  requestUploadSession: SourceBlobUploadSessionRequester;
}): Promise<void> {
  const { blobs, requestUploadSession } = options;
  const uniqueBlobs = new Map<string, SourceBlobUploadInput>();
  for (const blob of blobs) {
    const existing = uniqueBlobs.get(blob.contentHash);
    if (!existing) {
      uniqueBlobs.set(blob.contentHash, blob);
      continue;
    }

    if (existing.byteSize !== blob.byteSize) {
      throw new Error(
        \`Source blob \${blob.contentHash} has conflicting byte sizes.\`,
      );
    }
  }

  if (uniqueBlobs.size === 0) {
    return;
  }

  const { data, error, response } = await requestUploadSession(
    Array.from(uniqueBlobs.values(), ({ contentHash, byteSize }) => ({
      contentHash,
      byteSize,
    })),
  );

  if (error || !data) {
    throw new SourceBlobSessionRequestError(
      "Failed to create source blob upload session",
      error,
      response,
    );
  }
  assertSourceBlobUploadSession(data, response);

  for (const upload of data.uploads) {
    if (upload.status !== "upload_required") {
      continue;
    }

    const blob = uniqueBlobs.get(upload.contentHash);
    if (!blob) {
      throw new Error(
        \`Upload session referenced unknown source blob \${upload.contentHash}.\`,
      );
    }
    if (!upload.uploadTarget) {
      throw new Error(
        \`Upload target missing for source blob \${upload.contentHash}.\`,
      );
    }

    try {
      await uploadSourceBlob(upload.uploadTarget, blob.content);
      if (!(await confirmSourceBlobAlreadyExists({ requestUploadSession, blob }))) {
        throw new Error(
          \`Source blob \${blob.contentHash} was uploaded but not registered.\`,
        );
      }
    } catch (error) {
      if (
        isDuplicateDirectUploadError(error) &&
        (await confirmSourceBlobAlreadyExists({ requestUploadSession, blob }))
      ) {
        continue;
      }
      throw error;
    }
  }
}

export async function uploadProjectSourceBlobs(options: {
  projectId: string;
  blobs: SourceBlobUploadInput[];
}): Promise<void> {
  const { projectId, blobs } = options;
  return uploadSourceBlobs({
    blobs,
    requestUploadSession: (uploadBlobs) =>
      createProjectSourceBlobUploadSession({
        path: { projectId },
        body: { blobs: uploadBlobs },
      }),
  });
}
`,
);

await Bun.write(
  path.join(packageRoot, "src", "game-revisions.ts"),
  `export type JsonPrimitive = string | number | boolean | null;

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
): Promise<\`sha256:\${string}\`> {
  const canonical = canonicalJson({
    format: "dreamboard.game-revision/v1",
    sourceTreeHash: input.sourceTreeHash,
    ruleContentHash: input.ruleContentHash,
    manifestContentHash: input.manifestContentHash,
  });
  return \`sha256:\${await sha256Hex(textEncoder.encode(canonical))}\`;
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
`,
);

const zodModulePath = pathToFileURL(
  path.join(packageRoot, "src", "zod.gen.ts"),
).href;
const { zProblemType } = await import(zodModulePath);

function toProblemTypeKey(value: string): string {
  return value
    .replace(/^urn:dreamboard:problem:/, "")
    .replace(/-/g, "_")
    .toUpperCase();
}

const serverProblemTypes = (zProblemType.options as readonly string[])
  .map((value) => `  ${toProblemTypeKey(value)}: ${JSON.stringify(value)},`)
  .join("\n");

await Bun.write(
  path.join(packageRoot, "src", "generated", "problem-types.gen.ts"),
  `// This file is auto-generated by packages/api-client/scripts/generate.ts.
// Do not edit by hand.

import type { ProblemType } from "../types.gen.js";

export const SERVER_PROBLEM_TYPES = {
${serverProblemTypes}
} as const satisfies Record<string, ProblemType>;

export type ServerProblemType =
  (typeof SERVER_PROBLEM_TYPES)[keyof typeof SERVER_PROBLEM_TYPES];

export const CLIENT_PROBLEM_TYPES = {
  TRANSPORT_ERROR: "urn:dreamboard:problem:transport-error",
  UNKNOWN_API_ERROR: "urn:dreamboard:problem:unknown-api-error",
} as const;

export type ClientProblemType =
  (typeof CLIENT_PROBLEM_TYPES)[keyof typeof CLIENT_PROBLEM_TYPES];

export type AnyProblemType = ProblemType | ClientProblemType;
`,
);

const indexPath = path.join(packageRoot, "src", "index.ts");
const indexContents = await readFile(indexPath, "utf8");
const extraExports = `\nexport { CLIENT_PROBLEM_TYPES, SERVER_PROBLEM_TYPES, type AnyProblemType, type ClientProblemType, type ServerProblemType } from './generated/problem-types.gen.js';\n`;
if (!indexContents.includes("./generated/problem-types.gen.js")) {
  await Bun.write(indexPath, `${indexContents}${extraExports}`);
}

await rewriteRelativeImportSpecifiersToJs(path.join(packageRoot, "src"));
