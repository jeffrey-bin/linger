import { describe, expect, it } from "vitest";
import { matchesMediaContent } from "./media.js";
describe("file media content", () => {
  it("rejects renamed PDFs regardless of declared image/video metadata", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "video/mp4",
      "video/webm",
    ])
      expect(matchesMediaContent(Buffer.from("%PDF-1.7 renamed"), type)).toBe(
        false,
      );
  });
  it("distinguishes AVIF and QuickTime containers from MP4", () => {
    const avif = Buffer.from("\0\0\0\x20ftypavif\0\0\0\0avif");
    expect(matchesMediaContent(avif, "image/avif")).toBe(true);
    expect(
      matchesMediaContent(Buffer.from("\0\0\0\x20ftypqt  "), "video/mp4"),
    ).toBe(false);
    expect(
      matchesMediaContent(Buffer.from("\0\0\0\x20ftypqt  "), "video/quicktime"),
    ).toBe(true);
  });
  it("accepts an M4V container as MP4 video", () => {
    expect(
      matchesMediaContent(Buffer.from("\0\0\0\x20ftypM4V "), "video/mp4"),
    ).toBe(true);
  });
});
