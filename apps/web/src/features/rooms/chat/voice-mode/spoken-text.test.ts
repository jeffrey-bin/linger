import { describe, expect, it } from "vitest";

import { spokenSeparator } from "./spoken-text";

describe("spokenSeparator", () => {
  // Kana falls in the same CJK range as Han, so it reaches the unspaced branch.
  it("runs CJK fragments together and spaces Latin words", () => {
    expect(spokenSeparator("あしたぎゅうにゅう", "それとたまご")).toBe("");
    expect(spokenSeparator("Book a room", "for Friday")).toBe(" ");
    expect(spokenSeparator("よやくして", "Friday のかいぎしつ")).toBe("");
    expect(spokenSeparator("Call Alex", "それからメール")).toBe("");
    expect(spokenSeparator("ends with space ", "next")).toBe("");
    expect(spokenSeparator("", "only")).toBe("");
  });
});
