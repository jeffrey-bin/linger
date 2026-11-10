import { expect, it } from "vitest";
import {
  inferDocumentMediaType,
  inferFileMetadata,
  mediaTypeForExtension,
} from "./media-type.js";

const office = [
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
] as const;

it.each(office)(
  "infers %s case-insensitively only for missing or generic metadata",
  (extension, expected) => {
    for (const name of [
      `report.${extension}`,
      `folder/report.${extension.toUpperCase()}`,
      `C:\\folder\\report.${extension}`,
    ]) {
      expect(inferDocumentMediaType(name)).toBe(expected);
      for (const declared of [
        "",
        "  ",
        "application/octet-stream",
        "APPLICATION/OCTET-STREAM; charset=binary",
      ]) {
        expect(inferDocumentMediaType(name, declared)).toBe(expected);
      }
      for (const declared of [
        "application/pdf",
        "application/zip",
        "text/plain; charset=utf-8",
      ]) {
        expect(inferDocumentMediaType(name, declared)).toBe(declared);
      }
    }
  },
);

it.each([
  ["report.markdown", "text/markdown"],
  ["photo.jpeg", "image/jpeg"],
  ["report.HTML", "text/html"],
  ["table.csv", "text/csv"],
  ["report", "application/octet-stream"],
  ["report.unknown", "application/octet-stream"],
  ["folder.docx/report", "application/octet-stream"],
  [".docx", "application/octet-stream"],
  ["report.docx.exe", "application/octet-stream"],
])(
  "preserves known file types and the binary fallback for %s",
  (name, expected) => {
    expect(inferDocumentMediaType(name)).toBe(expected);
  },
);

it.each([
  ["photo.jpeg", "jpeg", "image/jpeg"],
  ["animation.webp", "webp", "image/webp"],
  ["clip.mov", "mov", "video/quicktime"],
  ["clip.ogv", "ogv", "video/ogg"],
  ["clip.M4V", "m4v", "video/mp4"],
  ["poster.avif", "avif", "image/avif"],
  ["voice.m4a", "m4a", "audio/mp4"],
  ["notes.txt", "plain_text", "text/plain"],
  ["script.mjs", "javascript", "text/javascript"],
  ["archive.tar.gz", "gz", "application/octet-stream"],
  ["report.constructor", "constructor", "application/octet-stream"],
  ["README", "binary", "application/octet-stream"],
])("reads %s from the one file type table", (name, format, mediaType) => {
  expect(inferFileMetadata(name)).toEqual({
    representation_format: format,
    media_type: mediaType,
  });
  expect(inferDocumentMediaType(name)).toBe(mediaType);
});

it("looks up an extension's media type for previews", () => {
  expect(mediaTypeForExtension("M4V")).toBe("video/mp4");
  expect(mediaTypeForExtension("csv")).toBe("text/csv");
  expect(mediaTypeForExtension("mmd")).toBeUndefined();
});
