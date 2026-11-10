import { describe, expect, it } from "vitest";

import { documentUploadRepresentationFormat } from "./document-upload-representation";

describe("documentUploadRepresentationFormat", () => {
  it.each([
    ["notes.md", "markdown"],
    ["notes.markdown", "markdown"],
    ["notes.txt", "plain_text"],
    ["trace.log", "plain_text"],
    ["notes.html", "html"],
    ["notes.htm", "html"],
    ["budget.xlsx", "xlsx"],
    ["deck.pptx", "pptx"],
    ["bundle.zip", "zip"],
    ["photo.png", "png"],
    ["icon.svg", "svg"],
    ["README", "binary"],
  ] as const)("maps %s to %s", (filename, format) => {
    expect(documentUploadRepresentationFormat({ name: filename })).toBe(format);
  });
});
