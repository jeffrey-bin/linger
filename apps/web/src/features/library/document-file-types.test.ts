import { describe, expect, it } from "vitest";
import { documentFileType } from "./document-file-types";

describe("Workspace file types", () => {
  it.each([
    ["report.DOCX", "word"],
    ["budget.xlsx", "spreadsheet"],
    ["data.csv", "spreadsheet"],
    ["slides.pptx", "presentation"],
    ["diagram.svg", "image"],
    ["assets.zip", "archive"],
    ["source.ts", "code"],
    ["unknown.custom", "others"],
  ])("classifies binary file %s as %s", (title, expected) => {
    expect(
      documentFileType({
        title,
        format: "binary",
        representation_format: "binary",
      }),
    ).toBe(expected);
  });
  it("includes native documents in Markdown", () => {
    expect(
      documentFileType({
        title: "Untitled",
        format: "blocknote",
        representation_format: "markdown",
      }),
    ).toBe("md");
  });
});
