import docFrameUrl from "./office-preview-frame-doc.ts?worker&url";
import docxFrameUrl from "./office-preview-frame-docx.ts?worker&url";
import pptFrameUrl from "./office-preview-frame-ppt.ts?worker&url";
import pptxFrameUrl from "./office-preview-frame-pptx.ts?worker&url";
import xlsFrameUrl from "./office-preview-frame-xls.ts?worker&url";
import xlsxFrameUrl from "./office-preview-frame-xlsx.ts?worker&url";
import { getOfficePreviewExtension } from "./office-preview-file-metadata";

const frameUrls = {
  doc: docFrameUrl,
  docx: docxFrameUrl,
  ppt: pptFrameUrl,
  pptx: pptxFrameUrl,
  xls: xlsFrameUrl,
  xlsx: xlsxFrameUrl,
};
const frameSources = new Map<string, Promise<string | undefined>>();

export function getOfficePreviewFrameUrl(filename: string) {
  const extension = getOfficePreviewExtension(filename);
  if (!extension) throw new Error("Unsupported Office preview format.");
  return frameUrls[extension];
}

/** Cache public code per format in the parent; never execute it outside the sandbox. */
export function loadOfficePreviewFrameSource(filename: string) {
  // Vite serves a live module graph in development, not a self-contained bundle.
  if (import.meta.env.DEV) return Promise.resolve(undefined);
  const url = getOfficePreviewFrameUrl(filename);
  let source = frameSources.get(url);
  if (!source) {
    // Same-origin cookies must go along: the edge proxy can challenge an
    // anonymous request, and the code is public, so they reveal nothing.
    source = fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(20_000),
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Office preview code could not be loaded.");
        return response.text();
      })
      .catch((error) => {
        frameSources.delete(url);
        throw error;
      });
    frameSources.set(url, source);
  }
  return source;
}
