import { describe, expect, it } from "vitest";
import { documentCardPresentation } from "./document-card-metadata";

describe("Document card metadata", () => {
  it("uses current Version metadata for binary uploads instead of a renamed title", () => {
    expect(
      documentCardPresentation({
        title: "Report.md",
        format: "binary",
        representation_format: "binary",
        version: {
          filename: "budget.xlsx",
          media_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      }),
    ).toEqual({
      filename: "Report.md",
      iconKind: "spreadsheet",
      typeLabel: "Excel",
    });
  });
  it("does not turn a native Document into Markdown because its title ends in md", () => {
    expect(
      documentCardPresentation({
        title: "Report.md",
        format: "blocknote",
        representation_format: "markdown",
      }),
    ).toEqual({
      filename: "Report.md",
      iconKind: "document",
      typeLabel: "Online document",
    });
  });
  it.each([
    ["markdown", "markdown", "Markdown"],
    ["pdf", "pdf", "PDF"],
    ["plain_text", "document", "Text"],
    ["xlsx", "spreadsheet", "Excel"],
  ])(
    "uses the authoritative %s format even when the title claims another format",
    (format, iconKind, typeLabel) => {
      expect(
        documentCardPresentation({
          title: "Misleading.pdf.md",
          format,
          representation_format: format,
        }),
      ).toEqual({ filename: "Misleading.pdf.md", iconKind, typeLabel });
    },
  );
  it("uses a neutral card while authorized metadata is unavailable", () => {
    expect(documentCardPresentation()).toEqual({
      filename: "Document",
      iconKind: "document",
      typeLabel: "Document",
    });
  });
});
