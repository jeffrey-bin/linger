import { officePreviewLimits } from "./office-preview-limits";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  inspectOfficePreviewFile,
  inspectOfficePreviewFileContents,
  inspectSpreadsheetRanges,
  OfficePreviewGuardError,
} from "./office-preview-guard";

describe("Office preview guard", () => {
  it("accepts an Office buffer at 50 MiB and rejects one byte more", () => {
    const buffer = new Uint8Array(50 * 1024 * 1024);
    buffer.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(
      inspectOfficePreviewFile({
        buffer: buffer.buffer,
        filename: "large.doc",
        mediaType: "application/msword",
      }),
    ).toEqual({ extension: "doc", isSpreadsheet: false });
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: new ArrayBuffer(50 * 1024 * 1024 + 1),
          filename: "large.doc",
          mediaType: "application/msword",
        }),
      "limit-exceeded",
    );
  });

  it("accepts a structurally valid OOXML package", () => {
    expect(
      inspectOfficePreviewFile({
        buffer: createZip(["[Content_Types].xml", "word/document.xml"]),
        filename: "Résumé déjà vu.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toEqual({ extension: "docx", isSpreadsheet: false });
  });

  it("verifies actual OOXML expanded bytes in the preflight worker", async () => {
    const buffer = await createCompressedZip();
    await expect(
      inspectOfficePreviewFileContents({
        buffer,
        filename: "verified.docx",
        mediaType: "application/octet-stream",
      }),
    ).resolves.toEqual({ extension: "docx", isSpreadsheet: false });
  });

  it("rejects OOXML whose declared expanded size does not match its bytes", async () => {
    const buffer = await createCompressedZip();
    forgeFirstCentralDirectoryExpandedSize(buffer, 1);
    await expect(
      inspectOfficePreviewFileContents({
        buffer,
        filename: "forged.docx",
        mediaType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "invalid-container" });
  });

  it.each(["", "application/octet-stream"])(
    "accepts a structurally valid OOXML package with generic media type %s",
    (mediaType) => {
      expect(
        inspectOfficePreviewFile({
          buffer: createZip(["[Content_Types].xml", "word/document.xml"]),
          filename: "uploaded.docx",
          mediaType,
        }),
      ).toEqual({ extension: "docx", isSpreadsheet: false });
    },
  );

  it("rejects an Office extension with a conflicting media type", () => {
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: createZip(["[Content_Types].xml", "word/document.xml"]),
          filename: "renamed.docx",
          mediaType: "image/png",
        }),
      "unsupported-file",
    );
  });

  it("rejects an encrypted OOXML entry", () => {
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: createZip(
            ["[Content_Types].xml", "ppt/presentation.xml"],
            0x1,
          ),
          filename: "deck.pptx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      "encrypted-file",
    );
  });

  it("rejects an OOXML package with the wrong internal structure", () => {
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: createZip(["[Content_Types].xml", "word/document.xml"]),
          filename: "renamed.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      "invalid-container",
    );
  });

  it("limits presentation slide count before rendering", () => {
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: createZip([
            "[Content_Types].xml",
            "ppt/presentation.xml",
            ...Array.from(
              { length: 301 },
              (_, index) => `ppt/slides/slide${index + 1}.xml`,
            ),
          ]),
          filename: "oversized.pptx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      "limit-exceeded",
    );
  });

  it("requires the OLE signature for legacy Office files", () => {
    expectGuardError(
      () =>
        inspectOfficePreviewFile({
          buffer: new Uint8Array([1, 2, 3, 4]).buffer,
          filename: "legacy.xls",
          mediaType: "application/vnd.ms-excel",
        }),
      "invalid-container",
    );
  });

  it("limits workbook sheets, rows, columns, and total cells", () => {
    expectGuardError(
      () =>
        inspectSpreadsheetRanges([{ name: "Oversized", range: "A1:IU20001" }]),
      "limit-exceeded",
    );
    expectGuardError(
      () => inspectSpreadsheetRanges([{ name: "Dense", range: "A1:IV4000" }]),
      "limit-exceeded",
    );
  });

  it("accepts workbook ranges inside the basic preview budget", () => {
    expect(() =>
      inspectSpreadsheetRanges([
        { name: "Français", range: "A1:Z200" },
        { name: "English", range: "B2:AZ500" },
      ]),
    ).not.toThrow();
  });

  it("accepts single-cell sheet references", () => {
    expect(() =>
      inspectSpreadsheetRanges([
        { name: "Single", range: "A1" },
        { name: "Absolute", range: "$C$7" },
      ]),
    ).not.toThrow();
    expectGuardError(
      () => inspectSpreadsheetRanges([{ name: "Bad", range: "A0" }]),
      "invalid-file",
    );
  });

  it("accepts a real xlsx whose only sheet has one cell", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["only"]]),
      "Single",
    );
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    const parsed = XLSX.read(bytes, { dense: true, type: "array" });
    const ranges = parsed.SheetNames.map((name) => {
      const sheet = parsed.Sheets[name];
      return { name, range: sheet?.["!fullref"] ?? sheet?.["!ref"] };
    });
    expect(ranges).toEqual([{ name: "Single", range: "A1" }]);
    expect(() => inspectSpreadsheetRanges(ranges)).not.toThrow();
  });

  it("reports the configured presentation slide limit", () => {
    const names = ["[Content_Types].xml"];
    for (
      let index = 1;
      index <= officePreviewLimits.maxSlides + 1;
      index += 1
    ) {
      names.push(`ppt/slides/slide${index}.xml`);
    }

    expect(() =>
      inspectOfficePreviewFile({
        buffer: createZip(names),
        filename: "too-many-slides.pptx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ).toThrow(
      `The presentation has more than ${officePreviewLimits.maxSlides} slides.`,
    );
  });
});

function expectGuardError(callback: () => void, code: string) {
  try {
    callback();
    throw new Error("Expected Office preview guard to reject the file.");
  } catch (error) {
    expect(error).toBeInstanceOf(OfficePreviewGuardError);
    expect((error as OfficePreviewGuardError).code).toBe(code);
  }
}

function createZip(names: string[], flags = 0) {
  const encoder = new TextEncoder();
  const localParts: number[] = [];
  const centralParts: number[] = [];
  let localOffset = 0;

  for (const name of names) {
    const encodedName = [...encoder.encode(name)];
    push32(localParts, 0x04034b50);
    push16(localParts, 20);
    push16(localParts, flags);
    push16(localParts, 0);
    push16(localParts, 0);
    push16(localParts, 0);
    push32(localParts, 0);
    push32(localParts, 0);
    push32(localParts, 0);
    push16(localParts, encodedName.length);
    push16(localParts, 0);
    localParts.push(...encodedName);

    push32(centralParts, 0x02014b50);
    push16(centralParts, 20);
    push16(centralParts, 20);
    push16(centralParts, flags);
    push16(centralParts, 0);
    push16(centralParts, 0);
    push16(centralParts, 0);
    push32(centralParts, 0);
    push32(centralParts, 0);
    push32(centralParts, 0);
    push16(centralParts, encodedName.length);
    push16(centralParts, 0);
    push16(centralParts, 0);
    push16(centralParts, 0);
    push16(centralParts, 0);
    push32(centralParts, 0);
    push32(centralParts, localOffset);
    centralParts.push(...encodedName);
    localOffset = localParts.length;
  }

  const result = [...localParts, ...centralParts];
  push32(result, 0x06054b50);
  push16(result, 0);
  push16(result, 0);
  push16(result, names.length);
  push16(result, names.length);
  push32(result, centralParts.length);
  push32(result, localParts.length);
  push16(result, 0);
  return new Uint8Array(result).buffer;
}

async function createCompressedZip() {
  const archive = new JSZip();
  archive.file("[Content_Types].xml", "<Types />");
  archive.file(
    "word/document.xml",
    `<document>${"verified-content".repeat(256)}</document>`,
  );
  return archive.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    type: "arraybuffer",
  });
}

function forgeFirstCentralDirectoryExpandedSize(
  buffer: ArrayBuffer,
  expandedSize: number,
) {
  const view = new DataView(buffer);
  for (let offset = 0; offset + 46 <= view.byteLength; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, expandedSize, true);
      return;
    }
  }
  throw new Error("Test ZIP has no central directory entry.");
}

function push16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function push32(target: number[], value: number) {
  push16(target, value & 0xffff);
  push16(target, (value >>> 16) & 0xffff);
}
