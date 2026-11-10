import { describe, expect, it } from "vitest";

import { documentFormatLabel } from "./document-format-label";

describe("documentFormatLabel", () => {
  it.each([
    ["blocknote", "md"],
    ["markdown", "md"],
    ["plain_text", "txt"],
    ["html", "html"],
    ["pdf", "pdf"],
    ["csv", "csv"],
  ])("maps the internal %s format to the product label %s", (format, label) => {
    expect(documentFormatLabel(format)).toBe(label);
  });

  it("normalizes an unknown format without inventing a type", () => {
    expect(documentFormatLabel("custom_format")).toBe("custom format");
  });
});
