import { artifactPreviewMaxFileBytes } from "./artifact-preview-limits";

export const officePreviewLimits = {
  maxCells: 1_000_000,
  maxColumnsPerSheet: 256,
  maxCompressionRatio: 200,
  maxEntries: 4_096,
  maxFileBytes: artifactPreviewMaxFileBytes,
  maxRowsPerSheet: 20_000,
  maxSheets: 64,
  maxSingleEntryBytes: 16 * 1024 * 1024,
  maxSlides: 200,
  maxUncompressedBytes: 64 * 1024 * 1024,
  preflightTimeoutMs: 10_000,
  renderTimeoutMs: 20_000,
} as const;
