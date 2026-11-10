import { describe, expect, it } from "vitest";

import { joinOcrHanRuns } from "../../src/document-normalizer/document-ocr.js";

// Han text built from code points: the repair only applies to Han characters.
const han = (...codePoints: number[]): string =>
  String.fromCodePoint(...codePoints);
const project = han(0x6668, 0x661f, 0x9879, 0x76ee);
const owner = han(0x5f20, 0x654f);

describe("OCR Han spacing repair", () => {
  it("joins Han characters that OCR split with spaces", () => {
    expect(joinOcrHanRuns([...project].join(" \t "))).toBe(project);
  });

  it("keeps Latin word spacing, Han-Latin spacing and line breaks", () => {
    const text = `${[...project].join(" ")} SCAN ORCHID 9876\n${[...owner].join(" ")}`;
    expect(joinOcrHanRuns(text)).toBe(`${project} SCAN ORCHID 9876\n${owner}`);
  });
});
