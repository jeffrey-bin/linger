import { expect, it } from "vitest";
import { formatKnowledgeCliOutput } from "./domains/knowledge/format-output.js";

it("retains metadata, source kinds, all ranked bodies and section handles without clipping", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `raw_0123456789abcdef_${index.toString(16).padStart(16, "0")}`,
    citeAs: `S${index + 1}`,
    title: "Research",
    excerpt: "Preview",
    content: "€✓".repeat(1500),
    source: {
      kind: index % 2 ? "wiki" : "room",
      ref: `source_${index}`,
    },
    representation: "source_excerpt",
    facet: "decision",
    metadata: { count: 1 },
    directory: [{ id: "summary", title: "Summary", level: 1 }],
  }));
  const result = formatKnowledgeCliOutput(
    "search",
    {},
    { schemaVersion: 1, status: "grounded", indexedAt: null, gaps: [], items },
  );
  expect(result.items).toEqual(
    items.map(({ id, directory, ...item }) => ({
      evidenceId: id,
      ...item,
      directory: directory.map(({ id, ...entry }) => ({
        sectionId: id,
        ...entry,
      })),
    })),
  );
  expect(result.gaps).toEqual([]);
});

it("preserves exact read continuation and rejects a response for different requested offsets", () => {
  const evidenceId = "raw_0123456789abcdef_0123456789abcdef";
  const response = {
    schemaVersion: 1,
    evidenceId,
    title: "Research",
    source: { kind: "raw", ref: "source" },
    directory: [{ id: "summary", title: "Summary", level: 1 }],
    sections: [
      {
        id: "summary",
        title: "Summary",
        level: 1,
        content: "Content",
        offset: 4,
        truncated: true,
        nextOffset: 11,
      },
    ],
    missingSections: [],
    complete: false,
  };
  const result = formatKnowledgeCliOutput(
    "read",
    { evidenceId, sectionRequests: [{ sectionId: "summary", offset: 4 }] },
    response,
  );
  expect(result.sections).toEqual([
    {
      sectionId: "summary",
      title: "Summary",
      level: 1,
      content: "Content",
      offset: 4,
      truncated: true,
      nextOffset: 11,
    },
  ]);
  expect(result.schemaVersion).toBe(2);
  expect(() =>
    formatKnowledgeCliOutput(
      "read",
      { evidenceId, sectionRequests: [{ sectionId: "summary", offset: 0 }] },
      response,
    ),
  ).toThrow();
});
