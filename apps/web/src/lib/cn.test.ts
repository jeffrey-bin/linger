import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("drops falsy values and keeps the order of the rest", () => {
    expect(cn("a", false, "b", null, undefined, "c")).toBe("a b c");
  });

  it("returns an empty string when every value is falsy", () => {
    expect(cn(false, null, undefined)).toBe("");
    expect(cn()).toBe("");
  });
});
