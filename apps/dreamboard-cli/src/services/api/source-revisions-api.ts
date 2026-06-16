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
    await uploadGameSourceBlobs({ gameId, blobs });
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
    await uploadProjectSourceBlobs({ projectId, blobs });
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
