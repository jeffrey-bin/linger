import { describe, expect, it } from "vitest";

import { findBrokenLinks, headingAnchors } from "./check-doc-links.mjs";

const root = "/repo";
const present = new Set([
  "/repo/docs/a.md",
  "/repo/docs/with space.md",
  "/repo/docs/café.md",
  "/repo/README.md",
]);
const headings: Record<string, string> = {
  "/repo/docs/with space.md": "# H",
  "/repo/README.md": "# Read me\n## Set-up `make` (v2)",
};
const options = {
  root,
  exists: (file: string) => present.has(file),
  anchors: (file: string) => headingAnchors(headings[file] ?? ""),
};
const check = (markdown: string, file = "docs/index.md") =>
  findBrokenLinks(markdown, file, options);

describe("findBrokenLinks", () => {
  it("resolves relative and root-absolute links", () => {
    expect(check("[a](./a.md) [r](/README.md) [up](../README.md)")).toEqual([]);
  });

  it("reports missing files with the original target", () => {
    expect(check("[x](missing.md#top) ![i](img.png)")).toEqual([
      "missing.md#top",
      "img.png",
    ]);
  });

  it("ignores fenced and inline code", () => {
    const markdown = [
      "```md",
      "[a](nope.md)",
      "```",
      "~~~",
      "[b](nope.md)",
      "~~~",
      "`[c](nope.md)` and ``[d](nope.md)``",
    ].join("\n");
    expect(check(markdown)).toEqual([]);
  });

  it("checks links after a closed fence", () => {
    expect(check("```\nx\n```\n[a](nope.md)")).toEqual(["nope.md"]);
  });

  it("skips schemes, anchors, angle brackets, and placeholders", () => {
    const markdown = [
      "[a](https://example.com/x) [b](mailto:a@b.c) [c](#section)",
      "[d](<nope file.md>) [e](./{name}.md) [f](./<id>.md) [g]($VAR/x.md)",
    ].join("\n");
    expect(check(markdown)).toEqual([]);
  });

  it("decodes percent-encoded names and strips fragments and queries", () => {
    expect(check("[a](with%20space.md#h) [b](caf%C3%A9.md?x=1)")).toEqual([]);
  });

  it("reports undecodable targets as broken", () => {
    expect(check("[a](bad%E0%A4%A.md)")).toEqual(["bad%E0%A4%A.md"]);
  });

  it("accepts titles and nested image links", () => {
    expect(check('[a](a.md "title") [![alt](a.md)](a.md)')).toEqual([]);
  });

  it("checks fragments against the linked Markdown file's headings", () => {
    expect(
      check("[a](../README.md#read-me) [b](/README.md#set-up-make-v2)"),
    ).toEqual([]);
    expect(check("[a](../README.md#missing) [b](./a.md#any)")).toEqual([
      "../README.md#missing",
      "./a.md#any",
    ]);
  });

  it("ignores headings inside fenced code", () => {
    expect([...headingAnchors("```\n# Not a heading\n```\n# Real")]).toEqual([
      "real",
    ]);
  });
});
