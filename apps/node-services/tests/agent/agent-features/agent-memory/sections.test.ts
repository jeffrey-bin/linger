import { describe, expect, it } from "vitest";
import {
  applyMemoryEdits,
  InvalidMemoryOutputError,
  memorySectionHeadings,
} from "../../../../src/agent/agent-features/agent-memory/sections.js";

const memory = [
  "# Agent memory",
  "",
  "## Releases",
  "",
  "- Orchard ships lantern-482.",
  "",
  "## Tooling",
  "",
  "````md",
  "## not a section",
  "```",
  "## still not a section",
  "````",
  "- Run the gate before merging.",
  "",
].join("\n");

describe("Agent memory section edits", () => {
  it("names only top-level sections outside fenced code", () => {
    expect(memorySectionHeadings(memory)).toEqual(["Releases", "Tooling"]);
    expect(memorySectionHeadings("")).toEqual([]);
  });

  it("rewrites the named section and keeps the rest byte for byte", () => {
    const edited = applyMemoryEdits(memory, [
      {
        op: "replace",
        heading: "Releases",
        content: "- Orchard ships kite-9.",
      },
    ]);
    expect(edited).toBe(
      memory.replace("- Orchard ships lantern-482.", "- Orchard ships kite-9."),
    );
  });

  it("appends added sections and drops deleted ones", () => {
    const edited = applyMemoryEdits(memory, [
      { op: "delete", heading: "Releases", content: "" },
      { op: "add", heading: "Contacts", content: "- Ask Mira about access." },
    ]);
    expect(memorySectionHeadings(edited)).toEqual(["Tooling", "Contacts"]);
    expect(edited).toContain("# Agent memory\n\n## Tooling\n");
    expect(edited).toMatch(
      /run the gate before merging\.\n\n## Contacts\n\n- Ask Mira about access\.\n$/iu,
    );
    expect(
      applyMemoryEdits("", [
        { op: "add", heading: "## Releases", content: "- lantern-482" },
      ]),
    ).toBe("## Releases\n\n- lantern-482\n");
  });

  it("merges repeated headings into the replaced section", () => {
    const repeated = `${memory}## Releases\n\n- Older note.\n`;
    const edited = applyMemoryEdits(repeated, [
      { op: "replace", heading: "Releases", content: "- One list." },
    ]);
    expect(memorySectionHeadings(edited)).toEqual(["Releases", "Tooling"]);
    expect(edited).not.toContain("Older note");
  });

  it("leaves the memory unchanged without edits", () => {
    expect(applyMemoryEdits(memory, [])).toBe(memory);
    expect(applyMemoryEdits(memory.trimEnd(), [])).toBe(memory.trimEnd());
  });

  it("separates an added section from a memory without a final newline", () => {
    expect(
      applyMemoryEdits("## Releases\n\n- lantern-482", [
        { op: "add", heading: "Tooling", content: "- Run the gate." },
      ]),
    ).toBe("## Releases\n\n- lantern-482\n\n## Tooling\n\n- Run the gate.\n");
  });

  it.each([
    [
      "an unknown section",
      [{ op: "replace", heading: "Missing", content: "x" }],
    ],
    [
      "a heading already in use",
      [{ op: "add", heading: "Tooling", content: "x" }],
    ],
    [
      "one section twice",
      [
        { op: "replace", heading: "Tooling", content: "x" },
        { op: "delete", heading: "Tooling", content: "" },
      ],
    ],
    [
      "content that opens another section",
      [{ op: "replace", heading: "Tooling", content: "x\n## Extra\ny" }],
    ],
    ["an empty heading", [{ op: "add", heading: " ## ", content: "x" }]],
    [
      "an unknown operation",
      [{ op: "rename", heading: "Tooling", content: "x" }],
    ],
    ["a value that is not a list", { op: "add" }],
  ])("rejects %s", (_, edits) => {
    expect(() => applyMemoryEdits(memory, edits)).toThrow(
      InvalidMemoryOutputError,
    );
  });
});
