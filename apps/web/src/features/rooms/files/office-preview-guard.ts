import { officePreviewLimits } from "./office-preview-limits";
import JSZip from "jszip";

import type { OfficePreviewErrorCode } from "./office-preview-protocol";
import {
  getOfficePreviewExtension,
  isOfficePreviewMediaTypeCompatible,
  type OfficePreviewExtension,
} from "./office-preview-file-metadata";

export class OfficePreviewGuardError extends Error {
  readonly code: OfficePreviewErrorCode;

  constructor(code: OfficePreviewErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "OfficePreviewGuardError";
  }
}

const legacyExtensions = new Set(["doc", "ppt", "xls"]);
const spreadsheetExtensions = new Set(["xls", "xlsx"]);
const zipExtensions = new Set(["docx", "pptx", "xlsx"]);
const oleSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface OfficePreviewFileMetadata {
  extension: OfficePreviewExtension;
  isSpreadsheet: boolean;
}

interface OfficeZipEntry {
  compressedBytes: number;
  name: string;
  uncompressedBytes: number;
}

interface ZipEntryStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipEntryStream;
  on(event: "end", callback: () => void): ZipEntryStream;
  on(event: "error", callback: (error: Error) => void): ZipEntryStream;
  pause(): ZipEntryStream;
  resume(): ZipEntryStream;
}

type StreamableZipObject = JSZip.JSZipObject & {
  internalStream(type: "uint8array"): ZipEntryStream;
};

export function inspectOfficePreviewFile({
  buffer,
  filename,
  mediaType,
}: {
  buffer: ArrayBuffer;
  filename: string;
  mediaType: string;
}): OfficePreviewFileMetadata {
  return inspectOfficePreviewContainer({ buffer, filename, mediaType })
    .metadata;
}

export async function inspectOfficePreviewFileContents(input: {
  buffer: ArrayBuffer;
  filename: string;
  mediaType: string;
}): Promise<OfficePreviewFileMetadata> {
  const inspected = inspectOfficePreviewContainer(input);
  if (inspected.zipEntries) {
    await inspectActualZipContents(input.buffer, inspected.zipEntries);
  }
  return inspected.metadata;
}

function inspectOfficePreviewContainer({
  buffer,
  filename,
  mediaType,
}: {
  buffer: ArrayBuffer;
  filename: string;
  mediaType: string;
}): {
  metadata: OfficePreviewFileMetadata;
  zipEntries?: OfficeZipEntry[];
} {
  if (buffer.byteLength === 0) {
    throw new OfficePreviewGuardError("invalid-file", "The file is empty.");
  }
  if (buffer.byteLength > officePreviewLimits.maxFileBytes) {
    throw new OfficePreviewGuardError(
      "limit-exceeded",
      "The file is larger than the 50 MiB basic preview limit.",
    );
  }

  const extension = getOfficePreviewExtension(filename);
  if (!extension || !isOfficePreviewMediaTypeCompatible(extension, mediaType)) {
    throw new OfficePreviewGuardError(
      "unsupported-file",
      "The filename and media type do not identify a supported Office file.",
    );
  }

  const bytes = new Uint8Array(buffer);
  let zipEntries: OfficeZipEntry[] | undefined;
  if (legacyExtensions.has(extension)) {
    if (!hasPrefix(bytes, oleSignature)) {
      throw new OfficePreviewGuardError(
        "invalid-container",
        "The legacy Office container signature is invalid.",
      );
    }
  } else if (isZipExtension(extension)) {
    zipEntries = inspectZipContainer(bytes, extension);
  }

  return {
    metadata: {
      extension,
      isSpreadsheet: spreadsheetExtensions.has(extension),
    },
    zipEntries,
  };
}

export function inspectSpreadsheetRanges(
  ranges: Array<{ name: string; range?: string }>,
) {
  if (ranges.length > officePreviewLimits.maxSheets) {
    throw new OfficePreviewGuardError(
      "limit-exceeded",
      `The workbook has more than ${officePreviewLimits.maxSheets} sheets.`,
    );
  }

  let totalCells = 0;
  for (const sheet of ranges) {
    if (!sheet.range) {
      continue;
    }
    const dimensions = parseSpreadsheetRange(sheet.range);
    if (
      dimensions.rows > officePreviewLimits.maxRowsPerSheet ||
      dimensions.columns > officePreviewLimits.maxColumnsPerSheet
    ) {
      throw new OfficePreviewGuardError(
        "limit-exceeded",
        `Sheet "${sheet.name}" exceeds the basic preview row or column limit.`,
      );
    }
    totalCells += dimensions.rows * dimensions.columns;
    if (totalCells > officePreviewLimits.maxCells) {
      throw new OfficePreviewGuardError(
        "limit-exceeded",
        "The workbook exceeds the 1,000,000-cell basic preview limit.",
      );
    }
  }
}

function inspectZipContainer(
  bytes: Uint8Array,
  extension: "docx" | "pptx" | "xlsx",
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw invalidZip("The Office ZIP central directory is missing.");
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
    entriesOnDisk !== totalEntries
  ) {
    throw invalidZip("Multi-disk Office ZIP files are not supported.");
  }
  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw invalidZip("ZIP64 Office files are not supported.");
  }
  if (totalEntries > officePreviewLimits.maxEntries) {
    throw limitError("The Office package contains too many entries.");
  }
  if (totalEntries === 0) {
    throw invalidZip("The Office ZIP contains no entries.");
  }
  if (
    centralDirectoryOffset + centralDirectorySize > eocdOffset ||
    centralDirectoryOffset > view.byteLength
  ) {
    throw invalidZip("The Office ZIP central directory is malformed.");
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  let slideCount = 0;
  let hasContentTypes = false;
  let hasFormatRoot = false;
  const names = new Set<string>();
  const zipEntries: OfficeZipEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > eocdOffset ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw invalidZip("The Office ZIP entry table is malformed.");
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
      localHeaderOffset === 0xffffffff
    ) {
      throw invalidZip("The Office ZIP entry metadata is invalid.");
    }
    if ((flags & 0x1) !== 0) {
      throw new OfficePreviewGuardError(
        "encrypted-file",
        "Encrypted Office files cannot be previewed.",
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidZip(
        "The Office ZIP uses an unsupported compression method.",
      );
    }
    if (compressionMethod === 0 && compressedBytes !== uncompressedBytes) {
      throw invalidZip("A stored Office ZIP entry has inconsistent sizes.");
    }
    if (
      compressionMethod === 8 &&
      uncompressedBytes > 0 &&
      compressedBytes === 0
    ) {
      throw limitError("The Office package has an unsafe compression ratio.");
    }
    if (uncompressedBytes > officePreviewLimits.maxSingleEntryBytes) {
      throw limitError(
        "An Office package entry is too large to preview safely.",
      );
    }
    if (
      compressedBytes > 0 &&
      uncompressedBytes / compressedBytes >
        officePreviewLimits.maxCompressionRatio
    ) {
      throw limitError("The Office package has an unsafe compression ratio.");
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > officePreviewLimits.maxUncompressedBytes) {
      throw limitError(
        "The expanded Office package is too large to preview safely.",
      );
    }

    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + filenameLength),
    );
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw invalidZip("The Office ZIP contains an unsafe entry path.");
    }
    if (names.has(name)) {
      throw invalidZip("The Office ZIP contains duplicate entry names.");
    }
    names.add(name);
    if (containsZip64Extra(view, cursor + 46 + filenameLength, extraLength)) {
      throw invalidZip("ZIP64 Office entries are not supported.");
    }
    inspectLocalZipEntry(
      view,
      localHeaderOffset,
      compressedBytes,
      centralDirectoryOffset,
    );
    zipEntries.push({ compressedBytes, name, uncompressedBytes });
    hasContentTypes ||= name === "[Content_Types].xml";
    hasFormatRoot ||= name.startsWith(`${officeRoot(extension)}/`);
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) {
      slideCount += 1;
      if (slideCount > officePreviewLimits.maxSlides) {
        throw limitError(
          `The presentation has more than ${officePreviewLimits.maxSlides} slides.`,
        );
      }
    }
    cursor = entryEnd;
  }

  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    throw invalidZip(
      "The Office ZIP entry count does not match its directory.",
    );
  }
  if (!hasContentTypes || !hasFormatRoot) {
    throw invalidZip(
      "The ZIP does not contain the expected Office document structure.",
    );
  }
  return zipEntries;
}

async function inspectActualZipContents(
  buffer: ArrayBuffer,
  expectedEntries: OfficeZipEntry[],
) {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, {
      checkCRC32: false,
      createFolders: false,
    });
  } catch (error) {
    throw invalidZip(
      error instanceof Error
        ? `The Office ZIP could not be opened: ${error.message}`
        : "The Office ZIP could not be opened.",
    );
  }

  let totalBytes = 0;
  for (const expected of expectedEntries) {
    if (expected.name.endsWith("/")) {
      if (expected.compressedBytes !== 0 || expected.uncompressedBytes !== 0) {
        throw invalidZip("An Office ZIP directory entry contains data.");
      }
      continue;
    }
    const entry = archive.file(expected.name);
    if (!entry) {
      throw invalidZip("The Office ZIP entry table could not be verified.");
    }
    const actualBytes = await countActualEntryBytes(entry, totalBytes);
    if (actualBytes !== expected.uncompressedBytes) {
      throw invalidZip("An Office ZIP entry has an incorrect expanded size.");
    }
    totalBytes += actualBytes;
  }
}

function countActualEntryBytes(entry: JSZip.JSZipObject, totalBefore: number) {
  return new Promise<number>((resolve, reject) => {
    // JSZip exposes this streaming API at runtime but omits it from its public
    // TypeScript declaration. The exact dependency version is locked and tested.
    const stream = (entry as StreamableZipObject).internalStream("uint8array");
    let entryBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on("data", (chunk: Uint8Array) => {
      entryBytes += chunk.byteLength;
      if (entryBytes > officePreviewLimits.maxSingleEntryBytes) {
        fail(
          limitError("An Office package entry is too large to preview safely."),
        );
      } else if (
        totalBefore + entryBytes >
        officePreviewLimits.maxUncompressedBytes
      ) {
        fail(
          limitError(
            "The expanded Office package is too large to preview safely.",
          ),
        );
      }
    });
    stream.on("error", (error: Error) =>
      fail(
        invalidZip(
          `An Office ZIP entry could not be expanded: ${error.message}`,
        ),
      ),
    );
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(entryBytes);
    });
    stream.resume();
  });
}

function inspectLocalZipEntry(
  view: DataView,
  offset: number,
  compressedBytes: number,
  centralDirectoryOffset: number,
) {
  if (
    offset + 30 > centralDirectoryOffset ||
    view.getUint32(offset, true) !== 0x04034b50
  ) {
    throw invalidZip("An Office ZIP local entry header is invalid.");
  }
  const filenameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + filenameLength + extraLength;
  if (dataOffset + compressedBytes > centralDirectoryOffset) {
    throw invalidZip("An Office ZIP entry extends beyond its data section.");
  }
  if (containsZip64Extra(view, offset + 30 + filenameLength, extraLength)) {
    throw invalidZip("ZIP64 Office entries are not supported.");
  }
}

function containsZip64Extra(view: DataView, offset: number, length: number) {
  const end = offset + length;
  if (end > view.byteLength) {
    throw invalidZip("An Office ZIP extra field is malformed.");
  }
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      throw invalidZip("An Office ZIP extra field is malformed.");
    }
    const headerId = view.getUint16(cursor, true);
    const fieldLength = view.getUint16(cursor + 2, true);
    if (cursor + 4 + fieldLength > end) {
      throw invalidZip("An Office ZIP extra field is malformed.");
    }
    if (headerId === 0x0001) {
      return true;
    }
    cursor += 4 + fieldLength;
  }
  return false;
}

function findEndOfCentralDirectory(view: DataView) {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (
    let offset = view.byteLength - 22;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) {
        return offset;
      }
    }
  }
  return -1;
}

function parseSpreadsheetRange(range: string) {
  const matches =
    /^(?:[^!]+!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(range);
  if (!matches) {
    throw new OfficePreviewGuardError(
      "invalid-file",
      "A workbook sheet has an invalid cell range.",
    );
  }
  const startColumn = columnIndex(matches[1]!);
  const endColumn = columnIndex(matches[3] ?? matches[1]!);
  const startRow = Number(matches[2]);
  const endRow = Number(matches[4] ?? matches[2]);
  if (endColumn < startColumn || endRow < startRow || startRow < 1) {
    throw new OfficePreviewGuardError(
      "invalid-file",
      "A workbook sheet has an invalid cell range.",
    );
  }
  return {
    columns: endColumn - startColumn + 1,
    rows: endRow - startRow + 1,
  };
}

function columnIndex(column: string) {
  let value = 0;
  for (const character of column.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

function officeRoot(extension: "docx" | "pptx" | "xlsx") {
  return extension === "docx" ? "word" : extension === "pptx" ? "ppt" : "xl";
}

function isZipExtension(
  extension: OfficePreviewExtension,
): extension is "docx" | "pptx" | "xlsx" {
  return zipExtensions.has(extension);
}

function hasPrefix(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function invalidZip(message: string) {
  return new OfficePreviewGuardError("invalid-container", message);
}

function limitError(message: string) {
  return new OfficePreviewGuardError("limit-exceeded", message);
}
