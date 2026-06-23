import { createProjectSourceBlobUploadSession } from "./sdk.gen.js";
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
    const suffix = details.trim().length > 0 ? `: ${details.trim()}` : "";
    super(`Failed to upload source blob (HTTP ${status}${suffix})`);
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
  response?: Response;
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
        `Source blob ${blob.contentHash} has conflicting byte sizes.`,
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
        `Upload session referenced unknown source blob ${upload.contentHash}.`,
      );
    }
    if (!upload.uploadTarget) {
      throw new Error(
        `Upload target missing for source blob ${upload.contentHash}.`,
      );
    }

    try {
      await uploadSourceBlob(upload.uploadTarget, blob.content);
      if (!(await confirmSourceBlobAlreadyExists({ requestUploadSession, blob }))) {
        throw new Error(
          `Source blob ${blob.contentHash} was uploaded but not registered.`,
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
