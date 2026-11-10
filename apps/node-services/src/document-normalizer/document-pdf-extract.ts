import { fileURLToPath } from "node:url";

import { createCanvas } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  DocumentNormalizationError,
  MAX_OCR_PIXELS,
  MAX_DOCUMENT_PAGES,
} from "./document-normalizer.js";
import { DocumentOcr } from "./document-ocr.js";

const PDFJS_MODULE_URL = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectRepeat,
]);

export async function extractPdfMarkdown(source: Uint8Array): Promise<string> {
  if (!Buffer.from(source.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  const loading = getDocument({
    data: Uint8Array.from(source),
    cMapPacked: true,
    cMapUrl: fileURLToPath(new URL("../../cmaps/", PDFJS_MODULE_URL)),
    standardFontDataUrl: fileURLToPath(
      new URL("../../standard_fonts/", PDFJS_MODULE_URL),
    ),
    wasmUrl: fileURLToPath(new URL("../../wasm/", PDFJS_MODULE_URL)),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    maxImageSize: MAX_OCR_PIXELS,
  });
  const ocr = new DocumentOcr();
  try {
    const document = await loading.promise;
    if (document.numPages > MAX_DOCUMENT_PAGES) {
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
    }
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const native = content.items
          .flatMap((item) =>
            "str" in item ? [item.str, item.hasEOL ? "\n" : " "] : [],
          )
          .join("")
          .replace(/ +\n/g, "\n")
          .trim();
        const operators = await page.getOperatorList();
        if (
          !operators.fnArray.some((operator) => IMAGE_OPERATORS.has(operator))
        ) {
          pages.push(native);
          continue;
        }
        const viewport = page.getViewport({ scale: 200 / 72 });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        if (width * height > MAX_OCR_PIXELS) {
          throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
        }
        const canvas = createCanvas(width, height);
        try {
          await page.render({ canvas: canvas as never, viewport }).promise;
          const recognized = await ocr.recognize(await canvas.encode("png"));
          // Keep exact text-layer spelling; do not discard scanned regions on mixed pages.
          const nativeLines = new Set(native.split("\n").map(compact));
          const extra = recognized
            .split("\n")
            .filter((line) => !nativeLines.has(compact(line)))
            .join("\n")
            .trim();
          pages.push([native, extra].filter(Boolean).join("\n\n"));
        } finally {
          canvas.width = canvas.height = 1;
        }
      } finally {
        page.cleanup();
      }
    }
    return pages.join("\n\n");
  } catch (error) {
    if (error instanceof DocumentNormalizationError) throw error;
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  } finally {
    ocr.dispose();
    await loading.destroy().catch(() => undefined);
  }
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}
