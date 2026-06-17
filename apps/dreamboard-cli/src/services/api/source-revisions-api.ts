import {
  type CreateSourceRevisionRequest,
  type QueueCompiledResultJobResponse,
  type SourceRevision,
} from "@dreamboard-games/api-client";
import {
  SourceBlobSessionRequestError,
  uploadProjectSourceBlobs,
  type SourceBlobUploadInput,
} from "@dreamboard-games/api-client/source-revisions";
import { toDreamboardApiError } from "../../utils/errors.js";

const SOURCE_BLOB_UPLOAD_BATCH_SIZE = 20;

export async function createSourceRevisionSdk(
  gameId: string,
  request: CreateSourceRevisionRequest,
): Promise<SourceRevision> {
  void gameId;
  void request;
  throw new Error("Game-scoped source revisions are no longer supported.");
}

export async function uploadSourceBlobsSdk(
  gameId: string,
  blobs: SourceBlobUploadInput[],
): Promise<void> {
  void gameId;
  void blobs;
  throw new Error("Game-scoped source blob uploads are no longer supported.");
}

export async function uploadProjectSourceBlobsSdk(
  projectId: string,
  blobs: SourceBlobUploadInput[],
): Promise<void> {
  try {
    for (const batch of chunkSourceBlobs(blobs)) {
      await uploadProjectSourceBlobs({ projectId, blobs: batch });
    }
  } catch (error) {
    if (error instanceof SourceBlobSessionRequestError) {
      throw toDreamboardApiError(
        error.apiError as Parameters<typeof toDreamboardApiError>[0],
        error.response,
        error.message,
      );
    }
    throw error;
  }
}

function chunkSourceBlobs(
  blobs: SourceBlobUploadInput[],
): SourceBlobUploadInput[][] {
  const chunks: SourceBlobUploadInput[][] = [];
  for (
    let index = 0;
    index < blobs.length;
    index += SOURCE_BLOB_UPLOAD_BATCH_SIZE
  ) {
    chunks.push(blobs.slice(index, index + SOURCE_BLOB_UPLOAD_BATCH_SIZE));
  }
  return chunks;
}

export async function queueCompiledResultJobSdk(options: {
  gameId: string;
  authoringStateId: string;
}): Promise<QueueCompiledResultJobResponse> {
  void options;
  throw new Error("Game-scoped compile jobs are no longer supported.");
}
