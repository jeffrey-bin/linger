import { describe, expect, it } from "vitest";

import { artifactFileKind, artifactFileTypeLabel } from "./artifact-file-kind";

describe("artifactFileKind", () => {
  it("uses a concrete media type before words in an extensionless title", () => {
    expect(artifactFileKind("PDF roadmap", "text/markdown")).toBe("markdown");
    expect(artifactFileKind("Go meeting", "audio/mpeg")).toBe("audio");
  });
  it.each([
    ["AGENTS.md", "markdown"],
    ["Quick Start.html", "html"],
    ["room-agent-flow.mmd", "code"],
    ["customers.csv", "spreadsheet"],
    ["launch.workflow", "workflow"],
    ["screenshot.png", "image"],
    ["recording.mp4", "video"],
    ["interview.mp3", "audio"],
    ["assets.zip", "archive"],
    ["brief.pdf", "pdf"],
    ["notes.docx", "document"],
    ["model.xlsx", "spreadsheet"],
    ["Untitled document", "document"],
    ["PDF sample", "pdf"],
    ["DOCX sample", "document"],
    ["TXT sample", "document"],
    ["MP4 sample", "video"],
    ["MP3 sample", "audio"],
    ["HTML sample", "html"],
    ["Excel XLSX sample", "spreadsheet"],
  ] as const)("classifies %s as %s", (filename, expected) => {
    expect(artifactFileKind(filename)).toBe(expected);
  });

  it("classifies by media type when the filename has no extension", () => {
    expect(artifactFileKind("quarterly brief", "application/pdf")).toBe("pdf");
  });

  it.each([
    ["brief.pdf", "PDF"],
    ["notes.docx", "Word"],
    ["deck.pptx", "PowerPoint"],
    ["model.xlsx", "Excel"],
    ["customers.csv", "CSV"],
    ["interview.mp3", "Audio"],
    ["recording.mp4", "Video"],
    ["page.html", "HTML"],
    ["notes.md", "Markdown"],
    ["readme.txt", "Text"],
    ["PDF sample", "PDF"],
    ["DOCX sample", "Word"],
    ["TXT sample", "Text"],
    ["MP4 sample", "Video"],
    ["Excel XLSX sample", "Excel"],
  ] as const)("labels %s as %s", (filename, expected) => {
    expect(artifactFileTypeLabel(filename)).toBe(expected);
  });
});
