export const dataPreviewLimits = {
  chunkBytes: 256 * 1024,
  maxBytes: 5 * 1024 * 1024,
  maxCellCharacters: 64 * 1024,
  maxCells: 500_000,
  maxColumns: 200,
  maxRows: 10_000,
  timeoutMs: 15_000,
} as const;

export interface DataPreviewRequest {
  blob: Blob;
  delimiter: "," | "\t";
  requestId: string;
  sourceSizeBytes: number;
}

export type DataPreviewResponse =
  | {
      kind: "parsed";
      requestId: string;
      rows: string[][];
      truncated: boolean;
      truncationReason?: string;
    }
  | {
      kind: "failed";
      message: string;
      requestId: string;
    };
