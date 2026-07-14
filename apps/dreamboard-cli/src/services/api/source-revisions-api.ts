import {
  SourceBlobSessionRequestError,
  uploadProjectSourceBlobs,
  type SourceBlobUploadInput,
} from "@dreamboard-games/api-client/source-revisions";
import { toDreamboardApiError } from "../../utils/errors.js";

const SOURCE_BLOB_UPLOAD_BATCH_SIZE = 20;

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
