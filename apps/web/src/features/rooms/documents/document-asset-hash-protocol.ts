export const documentAssetHashChunkBytes = 1024 * 1024;
export const documentAssetHashTimeoutMs = 2 * 60 * 1000;

export interface DocumentAssetHashRequest {
  file: File;
  requestId: string;
}

export type DocumentAssetHashResponse =
  | {
      bytesRead: number;
      kind: "hashed";
      requestId: string;
      sha256: string;
    }
  | {
      kind: "failed";
      message: string;
      requestId: string;
      stage: "hash" | "read";
    };
