import { createRequire } from "node:module";

import type { SupportedFileType } from "officeparser";

import { archiveLimits, listSafeZipFiles } from "./document-archive-extract.js";

import { DocumentNormalizationError } from "./document-normalizer.js";

const require = createRequire(import.meta.url);
const WordExtractor = require("word-extractor") as {
  new (): {
    extract(input: Buffer): Promise<{ getBody(): string }>;
  };
};

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function hasOleSignature(source: Uint8Array): boolean {
  return (
    source.byteLength >= OLE_SIGNATURE.length &&
    OLE_SIGNATURE.every((byte, index) => source[index] === byte)
  );
}

export function hasZipSignature(source: Uint8Array): boolean {
  if (source.byteLength < 4) return false;
  return (
    source[0] === 0x50 &&
    source[1] === 0x4b &&
    ((source[2] === 0x03 && source[3] === 0x04) ||
      (source[2] === 0x05 && source[3] === 0x06) ||
      (source[2] === 0x07 && source[3] === 0x08))
  );
}

export async function extractDocText(source: Uint8Array): Promise<string> {
  if (!hasOleSignature(source)) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  try {
    const document = await new WordExtractor().extract(Buffer.from(source));
    return document.getBody();
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/gu, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => {
      const code = Number(decimal);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/giu, " ")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

export async function extractOfficeMarkdown(
  source: Uint8Array,
  kind: SupportedFileType,
): Promise<string> {
  if (kind !== "html") await listSafeZipFiles(source);
  try {
    const { parseOffice } = await import("officeparser");
    const ast = await parseOffice(Buffer.from(source), {
      fileType: kind,
      allowRemoteAssets: false,
      ocr: false,
      extractAttachments: false,
      decompressionLimits: {
        maxUncompressedBytes: archiveLimits.maxUncompressedBytes,
        maxZipEntries: archiveLimits.maxEntries,
        maxTableCells: 100_000,
        maxXmlElements: 200_000,
      },
      onWarning: () => {},
    });
    if (ast.warnings.some((issue) => String(issue.code).includes("LIMIT"))) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
    }
    ast.metadata = {};
    return (
      await ast.to("md", {
        includeImages: "none",
        mdConfig: { dialect: "github", fallbackToHtml: false },
      })
    ).value;
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

export async function extractSpreadsheetMarkdown(
  source: Uint8Array,
): Promise<string> {
  await listSafeZipFiles(source);
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(source, { type: "array", cellNF: true });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name]!;
      if (!sheet["!ref"]) return "";
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 100_000) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
      }
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: false,
      });
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const lines = rows.map(
        (row) =>
          `| ${Array.from({ length: width }, (_, i) =>
            String(row[i] ?? "")
              .replace(/\r?\n/g, " ")
              .replaceAll("|", "\\|"),
          ).join(" | ")} |`,
      );
      lines.splice(
        1,
        0,
        `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
      );
      return `## ${name.replace(/[\r\n]/g, " ")}\n\n${lines.join("\n")}`;
    })
      .filter(Boolean)
      .join("\n\n");
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}
