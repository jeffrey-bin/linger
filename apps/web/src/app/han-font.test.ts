import { describe, expect, it } from "vitest";

import { prefersSimplifiedChinese } from "@/app/han-font";

describe("prefersSimplifiedChinese", () => {
  it.each([
    ["zh"],
    ["zh-CN"],
    ["zh-cn"],
    ["zh-SG"],
    ["zh-Hans"],
    ["zh-Hans-HK"],
  ])("loads the font for %s", (tag) => {
    expect(prefersSimplifiedChinese([tag])).toBe(true);
  });

  it.each([
    ["zh-TW"],
    ["zh-HK"],
    ["zh-Hant"],
    ["zh-Hant-CN"],
    ["ja"],
    ["en-US"],
    ["zhx"],
  ])("keeps the OS fallback for %s", (tag) => {
    expect(prefersSimplifiedChinese([tag])).toBe(false);
  });

  it("looks past the first preferred language", () => {
    expect(prefersSimplifiedChinese(["en-US", "zh-CN"])).toBe(true);
    expect(prefersSimplifiedChinese([])).toBe(false);
  });
});
