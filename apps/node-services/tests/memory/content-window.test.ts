import { describe, expect, it } from "vitest";
import { contentWindow } from "../../src/memory/search/content-window.js";
import { tokenizeSearchText } from "../../src/bm25.js";

const terms = (query: string) => new Set(tokenizeSearchText(query));
const filler = (label: string) =>
  `${label} ${"The assistant explains general packing advice in detail. ".repeat(6)}`;

describe("inline content window", () => {
  it("keeps short content unchanged", () => {
    expect(
      contentWindow("Max is a Golden Retriever.", terms("dog breed"), 800),
    ).toBe("Max is a Golden Retriever.");
  });

  it("starts at the Room message that holds the best query match", () => {
    const content = [
      "## 2023-05-19T23:46:00.000Z · user",
      filler("Intro."),
      "## 2023-05-19T23:46:01.000Z · assistant",
      filler("Advice."),
      "## 2023-05-20T08:00:00.000Z · user",
      "I packed five pairs of shoes for my last trip but wore only two.",
      "## 2023-05-20T08:00:01.000Z · assistant",
      filler("Reply."),
    ].join("\n\n");
    const window = contentWindow(content, terms("shoes packed last trip"), 800);
    expect(window.startsWith("…\n\n## 2023-05-20T08:00:00.000Z · user")).toBe(
      true,
    );
    expect(window).toContain("five pairs of shoes");
    expect(window.length).toBeLessThanOrEqual(805);
  });

  it("bounds a shorter window the same way", () => {
    const content = [
      "## 2023-05-19T23:46:00.000Z · user",
      filler("Intro."),
      "## 2023-05-20T08:00:00.000Z · user",
      "I packed five pairs of shoes for my last trip but wore only two.",
      filler("Reply."),
    ].join("\n\n");
    const window = contentWindow(content, terms("shoes packed"), 500);
    expect(window).toContain("five pairs of shoes");
    expect(window.length).toBeLessThanOrEqual(505);
  });

  it("keeps the chunk start when nothing matches", () => {
    const content = filler("Start.").repeat(3);
    expect(contentWindow(content, terms("zebra"), 800)).toBe(
      `${content.slice(0, 799)}…`,
    );
  });
});
