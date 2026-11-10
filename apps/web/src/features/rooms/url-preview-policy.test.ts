import { describe, expect, it } from "vitest";
import { shouldOpenUrlExternally } from "./url-preview-policy";

describe("URL preview policy", () => {
  it.each([
    ["http://example.com/", "https://app.example.com/", true],
    ["http://example.com/", "http://app.example.com/", false],
    ["https://app.example.com/docs", "https://app.example.com/", true],
    ["https://example.com/", "https://app.example.com/", false],
    ["https://192.169.1.1/", "https://app.example.com/", false],
    ["https://172.32.0.1/", "https://app.example.com/", false],
    ["https://172.31.255.255/", "https://app.example.com/", true],
    ["https://localhost./", "https://app.example.com/", true],
    ["https://test.localhost/", "https://app.example.com/", true],
  ])("routes %s from %s (external: %s)", (url, page, external) => {
    expect(shouldOpenUrlExternally(new URL(url), new URL(page))).toBe(external);
  });
});
