import { DocumentOcr } from "./document-ocr.js";
import {
  DocumentNormalizationError,
  MAX_DOCUMENT_PAGES,
  MAX_OCR_PIXELS,
} from "./document-normalizer.js";
import { decodeXmlEntities } from "./document-office-extract.js";

export function svgToMarkdown(xml: string, filename?: string): string {
  if (!/<svg\b/iu.test(xml)) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  const heading = imageHeading(filename, "SVG");
  const pieces: string[] = [];
  for (const tag of ["title", "desc", "text"] as const) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "giu");
    for (const match of xml.matchAll(pattern)) {
      const text = decodeXmlEntities(stripTags(match[1] ?? ""))
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
      if (text) pieces.push(text);
    }
  }
  if (pieces.length > 0) {
    return `# ${heading}\n\n${pieces.join("\n\n")}`;
  }
  return `# ${heading}\n\n- Format: SVG`;
}

function imageHeading(filename: string | undefined, fallback: string): string {
  const base = filename?.split(/[/\\]/u).at(-1)?.trim();
  return (base && base.length > 0 ? base : fallback).replaceAll("\n", " ");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, " ").replace(/[ \t]{2,}/gu, " ");
}

export async function rasterImageToMarkdown(
  source: Uint8Array,
  filename?: string,
): Promise<string> {
  const ocr = new DocumentOcr();
  // One sparse-layout retry per empty page stays inside the worker deadline.
  const recognize = async (png: Uint8Array): Promise<string> =>
    (await ocr.recognize(png)) || ocr.recognize(png, "11");
  try {
    let format: string;
    const results: string[] = [];
    // Sharp handles bounded decoding and all TIFF pages; Skia handles BMP.
    if (source[0] === 0x42 && source[1] === 0x4d) {
      format = "BMP";
      if (source.byteLength < 26) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
      }
      const header = new DataView(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
      const coreHeader = header.getUint32(14, true) === 12;
      const width = coreHeader
        ? header.getUint16(18, true)
        : header.getInt32(18, true);
      const height = coreHeader
        ? header.getUint16(20, true)
        : Math.abs(header.getInt32(22, true));
      if (width <= 0 || height <= 0) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
      }
      if (width * height > MAX_OCR_PIXELS) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
      }
      const { createCanvas, loadImage } = await import("@napi-rs/canvas");
      const image = await loadImage(Buffer.from(source));
      if (image.width * image.height > MAX_OCR_PIXELS) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
      }
      const canvas = createCanvas(image.width, image.height);
      try {
        canvas.getContext("2d").drawImage(image, 0, 0);
        results.push(await recognize(await canvas.encode("png")));
      } finally {
        canvas.width = canvas.height = 1;
      }
    } else {
      const { default: sharp } = await import("sharp");
      const metadata = await sharp(source, {
        limitInputPixels: MAX_OCR_PIXELS,
      }).metadata();
      format = metadata.format.toUpperCase();
      const pages = metadata.pages ?? 1;
      if (
        pages > MAX_DOCUMENT_PAGES ||
        (metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0) >
          MAX_OCR_PIXELS
      ) {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
      }
      for (let page = 0; page < pages; page++) {
        const png = await sharp(source, {
          page,
          pages: 1,
          limitInputPixels: MAX_OCR_PIXELS,
        })
          .rotate()
          .flatten({ background: "white" })
          .png()
          .toBuffer();
        results.push(await recognize(png));
      }
    }
    const text = results.filter(Boolean).join("\n\n");
    // A valid image without readable text is still a processed source, like
    // a text-less SVG; it must not block the documents around it.
    return text || `# ${imageHeading(filename, format)}\n\n- Format: ${format}`;
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  } finally {
    ocr.dispose();
  }
}
