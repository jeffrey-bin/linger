// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { applySearchTermHighlight } from "./search-term-highlight";

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const scope = globalThis as {
  CSS?: { highlights?: Map<string, unknown> };
  Highlight?: unknown;
};

describe("applySearchTermHighlight", () => {
  it("highlights a match after Unicode case conversion changes length", () => {
    const registry = new Map<string, unknown>();
    scope.CSS = { highlights: registry };
    scope.Highlight = FakeHighlight;
    document.body.innerHTML = "<p>İstanbul kraken</p>";
    applySearchTermHighlight(document.body.firstElementChild!, "kraken");
    const highlight = registry.get("search-term") as FakeHighlight | undefined;
    expect(highlight?.ranges.map((range) => range.toString())).toEqual([
      "kraken",
    ]);
  });
  afterEach(() => {
    delete scope.CSS;
    delete scope.Highlight;
    document.body.innerHTML = "";
  });

  it("registers one range per case-insensitive match and removes it on cleanup", () => {
    const registry = new Map<string, unknown>();
    scope.CSS = { highlights: registry };
    scope.Highlight = FakeHighlight;
    document.body.innerHTML =
      '<div class="message-row-body"><p>Kraken rollout plan, <strong>kraken</strong> retro</p></div>';
    const root = document.body.firstElementChild!;

    const cleanup = applySearchTermHighlight(root, " kraken ");

    const highlight = registry.get("search-term") as FakeHighlight;
    expect(highlight.ranges.map((range) => range.toString())).toEqual([
      "Kraken",
      "kraken",
    ]);
    cleanup();
    expect(registry.has("search-term")).toBe(false);
  });

  it("does nothing without a match or without browser support", () => {
    const registry = new Map<string, unknown>();
    scope.CSS = { highlights: registry };
    scope.Highlight = FakeHighlight;
    document.body.innerHTML =
      '<div class="message-row-body">nothing here</div>';
    applySearchTermHighlight(document.body.firstElementChild!, "kraken")();
    expect(registry.size).toBe(0);

    delete scope.Highlight;
    document.body.innerHTML = '<div class="message-row-body">kraken</div>';
    applySearchTermHighlight(document.body.firstElementChild!, "kraken")();
    expect(registry.size).toBe(0);
  });
});
