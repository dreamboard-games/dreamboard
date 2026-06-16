import {
  createSourceRevision,
  type CreateSourceRevisionRequest,
  queueCompiledResultJob,
  type QueueCompiledResultJobResponse,
  type SourceRevision,
} from "@dreamboard-games/api-client";
import {
  SourceBlobSessionRequestError,
  uploadGameSourceBlobs,
  uploadProjectSourceBlobs,
  type SourceBlobUploadInput,
} from "@dreamboard-games/api-client/source-revisions";
import { toDreamboardApiError } from "../../utils/errors.js";

const SOURCE_BLOB_UPLOAD_BATCH_SIZE = 20;

export async function createSourceRevisionSdk(
  gameId: string,
  request: CreateSourceRevisionRequest,
): Promise<SourceRevision> {
  const response = await createSourceRevision({
    path: { gameId },
    body: request,
  });

  if (response.error || !response.data) {
    throw toDreamboardApiError(
      response.error,
      response.response,
      "Failed to create source revision",
    );
  }

  return response.data;
}

export async function uploadSourceBlobsSdk(
  gameId: string,
  blobs: SourceBlobUploadInput[],
): Promise<void> {
  try {
    for (const batch of chunkSourceBlobs(blobs)) {
      await uploadGameSourceBlobs({ gameId, blobs: batch });
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
  for (let index = 0; index < blobs.length; index += SOURCE_BLOB_UPLOAD_BATCH_SIZE) {
    chunks.push(blobs.slice(index, index + SOURCE_BLOB_UPLOAD_BATCH_SIZE));
  }
  return chunks;
}

export async function queueCompiledResultJobSdk(options: {
  gameId: string;
  authoringStateId: string;
}): Promise<QueueCompiledResultJobResponse> {
  const { gameId, authoringStateId } = options;
  const { data, error, response } = await queueCompiledResultJob({
    path: { gameId },
    body: {
      authoringStateId,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to create compile job");
  }

  return data;
}
