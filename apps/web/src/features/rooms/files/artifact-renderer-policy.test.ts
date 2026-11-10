import { describe, expect, it } from "vitest";

import {
  resolveArtifactPreviewMediaType,
  selectArtifactRenderer,
} from "./artifact-renderer-policy";

describe("Artifact renderer policy", () => {
  it.each([
    ["brief.md", "text/markdown", 1024, "markdown"],
    ["browser.md", "text/x-markdown", 1024, "markdown"],
    ["desktop.markdown", "application/x-markdown", 1024, "markdown"],
    ["architecture.mmd", "text/plain", 1024, "mermaid"],
    ["diagram.svg", "image/svg+xml", 1024, "svg"],
    ["report.pdf", "application/pdf", 1024, "pdf"],
    ["accounts.csv", "text/csv", 1024, "csv"],
    ["accounts.tsv", "text/tab-separated-values", 1024, "csv"],
    ["photo.png", "image/png", 1024, "image"],
    ["meeting.mp4", "video/mp4", 500 * 1024 * 1024, "media"],
    ["interview.mp3", "audio/mpeg", 500 * 1024 * 1024, "media"],
    ["source.ts", "text/plain", 1024, "text"],
    ["workspace.yaml", "application/yaml", 1024, "text"],
    ["workspace.yml", "application/x-yaml", 1024, "text"],
    ["page.html", "text/html", 1024, "html"],
    ["brief.doc", "application/msword", 1024, "office"],
    [
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      1024,
      "office",
    ],
    ["deck.ppt", "application/vnd.ms-powerpoint", 1024, "office"],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      1024,
      "office",
    ],
    ["model.xls", "application/vnd.ms-excel", 1024, "office"],
    [
      "model.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      1024,
      "office",
    ],
    ["binary-brief.docx", "application/octet-stream", 1024, "office"],
    ["binary-deck.pptx", "application/octet-stream", 1024, "office"],
    ["binary-model.xlsx", "application/octet-stream", 1024, "office"],
    ["binary-brief.pdf", "application/octet-stream", 1024, "pdf"],
    ["binary-meeting.mp4", "application/octet-stream", 1024, "media"],
    ["binary-interview.mp3", "application/octet-stream", 1024, "media"],
    ["binary-page.html", "application/octet-stream", 1024, "html"],
    ["bundle.zip", "application/zip", 1024, "download"],
  ] as const)(
    "selects %s as %s",
    (filename, mediaType, sizeBytes, expectedKind) => {
      expect(
        selectArtifactRenderer({ filename, mediaType, sizeBytes }).kind,
      ).toBe(expectedKind);
    },
  );

  it.each([
    ["brief.md", "text/markdown", "markdown"],
    ["page.html", "text/html", "html"],
    ["diagram.mmd", "text/plain", "mermaid"],
    ["source.ts", "text/plain", "text"],
    ["diagram.svg", "image/svg+xml", "svg"],
    ["photo.png", "image/png", "image"],
    ["report.pdf", "application/pdf", "pdf"],
    ["brief.docx", "application/octet-stream", "office"],
    ["deck.pptx", "application/octet-stream", "office"],
    ["model.xlsx", "application/octet-stream", "office"],
  ])(
    "allows %s through 50 MiB and downloads larger files",
    (filename, mediaType, kind) => {
      expect(
        selectArtifactRenderer({
          filename,
          mediaType,
          sizeBytes: 50 * 1024 * 1024,
        }).kind,
      ).toBe(kind);
      expect(
        selectArtifactRenderer({
          filename,
          mediaType,
          sizeBytes: 50 * 1024 * 1024 + 1,
        }).kind,
      ).toBe("download");
    },
  );

  it("fails closed when active text exceeds its preview limit", () => {
    expect(
      selectArtifactRenderer({
        filename: "large.html",
        mediaType: "text/html",
        sizeBytes: 50 * 1024 * 1024 + 1,
      }),
    ).toEqual({
      kind: "download",
      reason: "This file is larger than the safe HTML preview limit.",
    });
  });

  it("does not trust a conflicting executable media type", () => {
    expect(
      selectArtifactRenderer({
        filename: "diagram.svg",
        mediaType: "text/html",
        sizeBytes: 1024,
      }).kind,
    ).toBe("download");
  });

  it("does not trust a media type that conflicts with the filename", () => {
    expect(
      selectArtifactRenderer({
        filename: "meeting.mp4",
        mediaType: "text/html",
        sizeBytes: 1024,
      }).kind,
    ).toBe("download");
  });

  it("does not trust a conflicting media type for an Office extension", () => {
    expect(
      selectArtifactRenderer({
        filename: "quarterly-report.docx",
        mediaType: "image/png",
        sizeBytes: 1024,
      }).kind,
    ).toBe("download");
  });

  it("falls back to download when an Office file exceeds 50 MiB", () => {
    expect(
      selectArtifactRenderer({
        filename: "quarterly-report.docx",
        mediaType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 50 * 1024 * 1024 + 1,
      }),
    ).toEqual({
      kind: "download",
      reason: "This file is larger than the 50 MiB basic Office preview limit.",
    });
  });

  it("maps generic binary uploads onto the filename's preview media type", () => {
    expect(
      resolveArtifactPreviewMediaType("brief.pdf", "application/octet-stream"),
    ).toBe("application/pdf");
    expect(
      resolveArtifactPreviewMediaType(
        "meeting.mp4",
        "application/octet-stream",
      ),
    ).toBe("video/mp4");
    expect(resolveArtifactPreviewMediaType("interview.mp3", "")).toBe(
      "audio/mpeg",
    );
    expect(
      resolveArtifactPreviewMediaType("clip.m4v", "application/octet-stream"),
    ).toBe("video/mp4");
    expect(resolveArtifactPreviewMediaType("notes.mmd", "")).toBe("text/plain");
    expect(
      resolveArtifactPreviewMediaType(
        "model.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
