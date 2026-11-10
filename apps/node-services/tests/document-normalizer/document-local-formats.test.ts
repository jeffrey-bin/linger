import { readFile } from "node:fs/promises";

import sharp from "sharp";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { normalizeDocumentContent } from "../../src/document-normalizer/document-normalizer-core.js";
import { resolveDocumentSourceKind } from "../../src/document-normalizer/document-source-kind.js";
import { zipFixture } from "./fixtures/document-normalizer-fixtures.js";

const fixtures = new URL("./fixtures/local-documents/", import.meta.url);
const manifest: Array<{ name: string; mediaType: string; facts: string[] }> =
  JSON.parse(await readFile(new URL("manifest.json", fixtures), "utf8"));
const compact = (value: string): string => value.replace(/\s+/gu, "");

async function convert(name: string, source?: Uint8Array): Promise<string> {
  const fixture = manifest.find((item) => item.name === name)!;
  return new TextDecoder().decode(
    await normalizeDocumentContent({
      filename: name,
      mediaType: fixture.mediaType,
      source: source ?? (await readFile(new URL(name, fixtures))),
    }),
  );
}

describe("local document extraction with bundled models", () => {
  it.each(manifest)(
    "extracts the body of $name",
    async (fixture) => {
      if (fixture.name === "blank.pdf") {
        await expect(convert(fixture.name)).rejects.toMatchObject({
          code: "DOCUMENT_SOURCE_EMPTY",
        });
        return;
      }
      const markdown = await convert(fixture.name);
      for (const fact of fixture.facts)
        expect(compact(markdown)).toContain(compact(fact));
      expect(markdown).not.toContain("data:image/");
      expect(markdown).not.toContain("file://");
    },
    30_000,
  );

  it.each(["structured.docx", "structured.pptx", "structured.xlsx"])(
    "preserves table column relationships in %s",
    async (name) => {
      const markdown = await convert(name);
      expect(markdown).toContain("| Project | Owner | Budget |");
      expect(markdown).toContain("| Aurora | Alice | 1250 |");
      expect(markdown).toContain("| Borealis | Bob | 2400 |");
    },
  );

  it("preserves sheet names, formatted dates, percentages and slide notes", async () => {
    const sheet = await convert("structured.xlsx");
    expect(sheet).toContain("## Dates");
    expect(sheet).toContain("| Launch | 2026-11-15 | 25% |");
    expect(await convert("structured.pptx")).toContain("SPEAKER-NOTE");
  });

  it("decodes JPEG, WebP, GIF, AVIF, BMP and both pages of a TIFF locally", async () => {
    const english = await readFile(new URL("ocr-en.png", fixtures));
    for (const format of ["jpeg", "webp", "gif", "avif"] as const) {
      const source = await sharp(english).toFormat(format).toBuffer();
      const result = await normalizeDocumentContent({
        filename: `scan.${format}`,
        mediaType: `image/${format}`,
        source,
      });
      expect(new TextDecoder().decode(result)).toContain("9876");
    }
    const { data, info } = await sharp(english)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const stride = Math.ceil((info.width * 3) / 4) * 4;
    const bitmap = Buffer.alloc(54 + stride * info.height);
    bitmap.write("BM");
    bitmap.writeUInt32LE(bitmap.length, 2);
    bitmap.writeUInt32LE(54, 10);
    bitmap.writeUInt32LE(40, 14);
    bitmap.writeInt32LE(info.width, 18);
    bitmap.writeInt32LE(info.height, 22);
    bitmap.writeUInt16LE(1, 26);
    bitmap.writeUInt16LE(24, 28);
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const input = (y * info.width + x) * 3;
        const output = 54 + (info.height - y - 1) * stride + x * 3;
        bitmap[output] = data[input + 2]!;
        bitmap[output + 1] = data[input + 1]!;
        bitmap[output + 2] = data[input]!;
      }
    const bitmapText = await normalizeDocumentContent({
      filename: "scan.bmp",
      mediaType: "image/bmp",
      source: bitmap,
    });
    expect(new TextDecoder().decode(bitmapText)).toContain("9876");
    const sparse = await readFile(new URL("ocr-sparse.png", fixtures));
    const size = await sharp(english).metadata();
    const frame = await sharp(sparse)
      .resize(size.width, size.height, {
        fit: "contain",
        background: "white",
      })
      .toBuffer();
    const tiff = await sharp([english, frame], { join: { animated: true } })
      .tiff()
      .toBuffer();
    const result = new TextDecoder().decode(
      await normalizeDocumentContent({
        filename: "scans.tiff",
        mediaType: "image/tiff",
        source: tiff,
      }),
    );
    expect(compact(result)).toContain("SCAN-ORCHID");
    // The resized sparse frame comes back with mixed letter case.
    expect(compact(result).toLowerCase()).toContain("sparse9876");
  }, 30_000);

  it.each([
    "sample.odt",
    "sample.ods",
    "sample.odp",
    "sample.epub",
    "sample.dotx",
  ])("recognizes a ZIP-labelled document by its filename: %s", async (name) => {
    const actual = resolveDocumentSourceKind({
      filename: name,
      mediaType: "application/zip",
    });
    expect(actual).not.toBe("zip");
    const markdown = await normalizeDocumentContent({
      filename: name,
      mediaType: "application/zip",
      source: await readFile(new URL(name, fixtures)),
    });
    expect(new TextDecoder().decode(markdown)).toContain("1250");
  });

  it.each([
    [
      "pptx",
      "potx",
      "presentationml.presentation.main",
      "presentationml.template.main",
    ],
    [
      "pptx",
      "ppsx",
      "presentationml.presentation.main",
      "presentationml.slideshow.main",
    ],
    ["xlsx", "xltx", "spreadsheetml.sheet.main", "spreadsheetml.template.main"],
  ])(
    "extracts %s as a %s template or slideshow",
    async (original, extension, before, after) => {
      const zip = await JSZip.loadAsync(
        await readFile(new URL(`structured.${original}`, fixtures)),
      );
      zip.file(
        "[Content_Types].xml",
        (await zip.file("[Content_Types].xml")!.async("string")).replace(
          before,
          after,
        ),
      );
      const result = await normalizeDocumentContent({
        filename: `sample.${extension}`,
        mediaType: "application/octet-stream",
        source: await zip.generateAsync({ type: "uint8array" }),
      });
      expect(new TextDecoder().decode(result)).toContain(
        "| Aurora | Alice | 1250 |",
      );
    },
  );

  it("rejects archives with unsafe paths before parsing Office content", async () => {
    await expect(
      normalizeDocumentContent({
        filename: "bad.docx",
        mediaType: "application/octet-stream",
        source: zipFixture([{ name: "../outside.xml", value: "secret" }]),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_INVALID" });
  });

  it("rejects an oversized bitmap before allocating decoded pixels", async () => {
    const source = Buffer.alloc(54);
    source.write("BM");
    source.writeUInt32LE(40, 14);
    source.writeInt32LE(100_000, 18);
    source.writeInt32LE(100_000, 22);
    await expect(
      normalizeDocumentContent({
        filename: "huge.bmp",
        mediaType: "image/bmp",
        source,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_SOURCE_TOO_LARGE" });
  });

  it("decodes MIME transfer encoding and an encoded subject", async () => {
    const source = Buffer.from(
      [
        "MIME-Version: 1.0",
        "Subject: =?UTF-8?B?cHJvamV0IMOJdG9pbGU=?=",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("Budget 1250 €").toString("base64"),
      ].join("\r\n"),
    );
    const result = await normalizeDocumentContent({
      filename: "mail.eml",
      mediaType: "message/rfc822",
      source,
    });
    expect(new TextDecoder().decode(result)).toContain("Budget 1250 €");
    expect(new TextDecoder().decode(result)).toContain("projet Étoile");
  });
});
