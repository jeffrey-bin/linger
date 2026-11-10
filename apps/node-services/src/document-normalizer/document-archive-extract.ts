import { gunzipSync } from "node:zlib";

import JSZip from "jszip";

import {
  DocumentNormalizationError,
  MAX_DOCUMENT_SOURCE_BYTES,
} from "./document-normalizer.js";
import { hasZipSignature } from "./document-office-extract.js";

export const archiveLimits = {
  maxCompressionRatio: 200,
  maxEntries: 1_024,
  maxSingleEntryBytes: 16 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
} as const;

const GZIP_SIGNATURE = [0x1f, 0x8b];

export function hasGzipSignature(source: Uint8Array): boolean {
  return (
    source.byteLength >= GZIP_SIGNATURE.length &&
    GZIP_SIGNATURE.every((byte, index) => source[index] === byte)
  );
}

export function inflateGzip(source: Uint8Array): Uint8Array {
  if (!hasGzipSignature(source)) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  try {
    return new Uint8Array(
      gunzipSync(source, { maxOutputLength: MAX_DOCUMENT_SOURCE_BYTES }),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
    }
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

export function stripGzipExtension(
  filename: string | undefined,
): string | undefined {
  if (!filename) return undefined;
  return filename.replace(/\.gz(ip)?$/iu, "");
}

export interface ArchiveFile {
  bytes: Uint8Array;
  filename: string;
}

export async function listSafeZipFiles(
  source: Uint8Array,
): Promise<ArchiveFile[]> {
  if (!hasZipSignature(source)) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  const expected = inspectZipEntries(source);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(source, {
      checkCRC32: false,
      createFolders: false,
    });
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }

  const files: ArchiveFile[] = [];
  for (const entry of expected) {
    const file = archive.file(entry.name);
    if (!file || file.dir) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    let bytes: Uint8Array;
    try {
      bytes = await file.async("uint8array");
    } catch {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (bytes.byteLength > entry.uncompressedBytes) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    files.push({ bytes, filename: entry.name });
  }
  return files;
}

export function archiveEntryHeading(filename: string): string {
  return filename
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0)
    .join("/")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

interface InspectedZipEntry {
  name: string;
  uncompressedBytes: number;
}

function inspectZipEntries(source: Uint8Array): InspectedZipEntry[] {
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    totalEntries > archiveLimits.maxEntries ||
    centralDirectoryOffset + centralDirectorySize > eocdOffset ||
    centralDirectoryOffset > view.byteLength
  ) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  const names = new Set<string>();
  const entries: InspectedZipEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > eocdOffset ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const filenameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const entryEnd = cursor + 46 + filenameLength + extraLength + commentLength;
    if (
      entryEnd > eocdOffset ||
      diskStart !== 0 ||
      localHeaderOffset === 0xffffffff ||
      containsZip64Extra(view, cursor + 46 + filenameLength, extraLength)
    ) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    const name = decoder.decode(
      source.subarray(cursor + 46, cursor + 46 + filenameLength),
    );
    cursor = entryEnd;
    if (name.endsWith("/")) continue;
    if (shouldSkipArchivePath(name)) continue;
    if ((flags & 0x1) !== 0) continue;
    if (isUnsafeZipPath(name)) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (compressionMethod === 0 && compressedBytes !== uncompressedBytes) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (
      uncompressedBytes > archiveLimits.maxSingleEntryBytes ||
      (compressedBytes > 0 &&
        uncompressedBytes / compressedBytes > archiveLimits.maxCompressionRatio)
    ) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > archiveLimits.maxUncompressedBytes) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (names.has(name)) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    names.add(name);
    inspectLocalZipEntry(
      view,
      localHeaderOffset,
      compressedBytes,
      centralDirectoryOffset,
    );
    entries.push({ name, uncompressedBytes });
  }

  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }

  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function inspectLocalZipEntry(
  view: DataView,
  offset: number,
  compressedBytes: number,
  centralDirectoryOffset: number,
): void {
  if (
    offset + 30 > centralDirectoryOffset ||
    view.getUint32(offset, true) !== 0x04034b50
  ) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  const filenameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + filenameLength + extraLength;
  if (
    dataOffset + compressedBytes > centralDirectoryOffset ||
    containsZip64Extra(view, offset + 30 + filenameLength, extraLength)
  ) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

function containsZip64Extra(
  view: DataView,
  offset: number,
  length: number,
): boolean {
  const end = offset + length;
  if (end > view.byteLength) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    const headerId = view.getUint16(cursor, true);
    const fieldLength = view.getUint16(cursor + 2, true);
    if (cursor + 4 + fieldLength > end) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
    }
    if (headerId === 0x0001) return true;
    cursor += 4 + fieldLength;
  }
  return false;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (
    let offset = view.byteLength - 22;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
  }
  return -1;
}

function shouldSkipArchivePath(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  const base = normalized.split("/").at(-1) ?? "";
  return (
    normalized === "__MACOSX" ||
    normalized.startsWith("__MACOSX/") ||
    normalized.includes("/__MACOSX/") ||
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base.startsWith("._")
  );
}

function isUnsafeZipPath(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.split("/").includes("..")
  );
}
