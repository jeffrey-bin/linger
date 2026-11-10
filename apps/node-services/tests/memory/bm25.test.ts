import { describe, expect, it } from "vitest";
import { searchBm25, tokenizeSearchText } from "../../src/bm25.js";
import { chunkSource } from "../../src/memory/search/chunks.js";

// The analyzer splits Han from Latin and indexes Han character pairs, so these
// probes must be Han text; code points keep the source file free of Han.
const HAN = {
  ownsWhat: "\u8d1f\u8d23\u4ec0\u4e48",
  ownsHardware: "\u8d1f\u8d23\u786c\u4ef6",
  hardwareDiscussion: "\u786c\u4ef6\u8ba8\u8bba",
  hardwareDiscussionPairs: ["\u786c\u4ef6", "\u4ef6\u8ba8", "\u8ba8\u8bba"],
};

describe("standard BM25", () => {
  const documents = [
    { value: "a", text: "apple apple banana" },
    { value: "b", text: "banana carrot" },
    { value: "c", text: "carrot" },
  ];

  it("matches hand-calculated TF, DF and token-length normalization", () => {
    // N=3, avgdl=2, df(apple)=1, tf=2, dl=3.
    const expected =
      (Math.log(1 + 2.5 / 1.5) * (2 * 2.2)) /
      (2 + 1.2 * (0.25 + (0.75 * 3) / 2));
    expect(searchBm25(documents, "apple")[0]?.score).toBeCloseTo(expected, 12);
  });

  it("adds multiple term scores, uses OR recall and deduplicates query words", () => {
    const apple = searchBm25(documents, "apple")[0]!.score;
    const banana = searchBm25(documents, "banana").find(
      ({ value }) => value === "a",
    )!.score;
    const combined = searchBm25(documents, "apple banana");
    expect(combined[0]).toMatchObject({ value: "a", coverage: 1 });
    expect(combined[0]?.score).toBeCloseTo(apple + banana, 12);
    expect(combined.map(({ value }) => value)).toContain("b");
    expect(searchBm25(documents, "apple apple")).toEqual(
      searchBm25(documents, "apple"),
    );
  });

  it("has no artificial score for empty, punctuation-only or unmatched queries", () => {
    for (const query of ["", "?!", "absent"])
      expect(searchBm25(documents, query)).toEqual([]);
    expect(searchBm25([], "apple")).toEqual([]);
    expect(searchBm25([{ value: "empty", text: "" }], "apple")).toEqual([]);
  });

  it("uses the same Unicode analyzer for mixed Chinese and Latin text", () => {
    expect(tokenizeSearchText(`Ｊｅｆｆ${HAN.ownsWhat}`)).toContain("jeff");
    expect(tokenizeSearchText(HAN.hardwareDiscussion)).toEqual(
      expect.arrayContaining(HAN.hardwareDiscussionPairs),
    );
    expect(
      searchBm25(
        [{ value: 1, text: `Jeff ${HAN.ownsHardware}` }],
        `Jeff${HAN.ownsWhat}`,
      )[0]?.value,
    ).toBe(1);
  });

  it("normalizes by all tokens including repeated terms, not unique terms", () => {
    const results = searchBm25(
      [
        { value: "short", text: "apple banana" },
        { value: "long", text: `apple ${"banana ".repeat(100)}` },
      ],
      "apple",
    );
    expect(results[0]?.value).toBe("short");
  });
});

describe("query-time source chunks", () => {
  it("preserves source bytes, offsets and stable IDs across multiple headings", () => {
    const text =
      "# Meeting\r\n\r\n## Budget\r\n\r\nExactly 37.5k USD.\r\n\r\n## Decision\r\n\r\nUse cobalt.\r\n";
    const chunks = chunkSource(text);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(text);
    expect(chunks).toEqual(chunkSource(text));
    for (const chunk of chunks)
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
    expect(chunks.some((chunk) => chunk.heading === "Budget")).toBe(true);
  });

  it("bounds giant lines and retains Unicode surrogate pairs", () => {
    const text = "Café🙂".repeat(4_000);
    const chunks = chunkSource(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(text.length);
    expect(
      chunks.every(
        (chunk, index) => index === 0 || chunk.start <= chunks[index - 1]!.end,
      ),
    ).toBe(true);
    expect(chunks.every((chunk) => chunk.content.length <= 3_000)).toBe(true);
    expect(
      chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk.content)),
    ).toBe(true);
  });

  it("tracks heading hierarchy and one-based source lines", () => {
    const chunks = chunkSource("# Product\n\n## Decision\n\nUse BLE.\n");
    expect(chunks.at(-1)).toMatchObject({
      headingPath: ["Product", "Decision"],
      lineStart: 3,
      lineEnd: 5,
    });
  });

  it("packs consecutive timestamped speaker turns instead of indexing one-line fragments", () => {
    const text = [
      "## 2026-09-02T10:00:00+08:00 · Alice\n\nFirst line.\n",
      "## 2026-09-02T10:00:05+08:00 · Bob\n\nSecond line.\n",
      "## 2026-09-02T10:00:10+08:00 · Alice\n\nThird line.\n",
    ].join("\n");
    const chunks = chunkSource(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(text);
    expect(chunks[0]?.headingPath).toEqual([
      "2026-09-02T10:00:00+08:00 · Alice",
    ]);
  });

  it("does not treat fenced code as a section and changes IDs with the snapshot", () => {
    const text = "## Actual\n\n```md\n# Not a heading\n```\n";
    expect(chunkSource(text).map((chunk) => chunk.heading)).toEqual(["Actual"]);
    expect(chunkSource(text)[0]?.id).not.toBe(
      chunkSource(`${text}changed`)[0]?.id,
    );
  });
});
