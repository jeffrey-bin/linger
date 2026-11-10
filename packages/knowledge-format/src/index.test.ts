import { describe, expect, it } from "vitest";

import {
  normalizeOkfMarkdown,
  parseOkfFrontmatter,
  setOkfRootIndexVersion,
  validateOkfDocument,
} from "./index.js";

describe("validateOkfDocument", () => {
  it.each([
    ["sources", "\n  - resource: memory://one\n  - resource: memory://two"],
    ["tags", "\n  - hardware"],
    ["graph", "\n  id: client_example\n  about: [client_example]"],
    ["title", ' "Client: Example"'],
    ["custom_extension", " { retained: true }"],
  ])(
    "repairs parser-identified root indentation for %s without changing values",
    (key, value) => {
      const valid = `---\ntype: Client Memory\nverified: []\n${key}:${value}\n---\n\n# Example\n\nKeep body: exactly.\n`;
      for (const indent of [1, 2, 3]) {
        const broken = valid.replace(
          `\n${key}:`,
          `\n${" ".repeat(indent)}${key}:`,
        );
        const normalized = normalizeOkfMarkdown(broken);
        expect(normalized).toBe(valid);
        expect(parseOkfFrontmatter(normalized).fields).toEqual(
          parseOkfFrontmatter(valid).fields,
        );
        expect(normalizeOkfMarkdown(normalized)).toBe(normalized);
      }
    },
  );

  it("repairs a misplaced root field after a nested mapping without moving its children", () => {
    const valid = `---\ntype: Memory\ngenerated:\n  by: memory/1\nsources:\n  - title: First\n    resource: memory://one\n  - title: Second\n    resource: memory://two\n---\n\n# Example\n`;
    expect(
      normalizeOkfMarkdown(valid.replace("\nsources:", "\n sources:")),
    ).toBe(valid);
  });

  it("repairs multiple root indentation errors while preserving valid block text in the same document", () => {
    const valid = `---\ntype: Memory\ndescription: |\n  Example: keep verbatim\n  - title: Literal: untouched\nverified: []\nsources:\n  - resource: memory://one\ntags: [hardware]\ngraph:\n  id: example\n---\n\n# Example\n`;
    const broken = valid
      .replace("\nsources:", "\n sources:")
      .replace("\ntags:", "\n tags:")
      .replace("\ngraph:", "\n graph:");
    expect(normalizeOkfMarkdown(broken)).toBe(valid);
  });

  it.each([
    'description: "A valid\n  multi-line value"\nresource: memory://one # provenance',
    'description: |\n  Preserve these examples:\n   sources:\n    - title: Example: keep verbatim\n      resource: literal://example\n  including a trailing quote"',
    "description: >-\n  Example: delivery\n  remains a folded string.",
    'extension:\n  sources:\n    - resource: memory://nested\n      title: "Example: nested"',
  ])("preserves valid YAML byte-for-byte: %s", (metadata) => {
    const content = `---\ntype: Memory\n${metadata}\n---\n\n# Example\n`;
    expect(normalizeOkfMarkdown(content)).toBe(content);
    expect(parseOkfFrontmatter(content).issues).toEqual([]);
  });

  it.each([
    "type: Memory\ngenerated:\n  by: memory/1\n   at: 2026-09-10T08:00:00Z",
    "type: Memory\nverified: []\n sources: [one",
    "type: Memory\nstatus: stable\nverified: []\n status: draft",
    "type: Memory\nverified: []\n sources:\n  - title: Missing resource",
  ])(
    "keeps ambiguous, conflicting or semantically invalid metadata rejected: %s",
    (metadata) => {
      const content = `---\n${metadata}\n---\n\n# Example\n`;
      expect(
        validateOkfDocument(normalizeOkfMarkdown(content), {
          relativePath: "example.md",
        }).valid,
      ).toBe(false);
    },
  );

  it("collapses identical scalar duplicates without merging conflicting values or different maps", () => {
    const content = `---\ntype: Client Memory\nlast_contact_at: 2026-08-25\nlast_contact_at: "2026-08-25"\ngenerated:\n  by: memory/1\n  by: memory/1\nsources:\n  - resource: memory://one\n  - resource: memory://two\n---\n\n# Client\n`;
    const normalized = normalizeOkfMarkdown(content);
    expect(normalized.match(/last_contact_at:/gu)).toHaveLength(1);
    expect(parseOkfFrontmatter(normalized).fields).toMatchObject({
      last_contact_at: "2026-08-25",
      generated: { by: "memory/1" },
      sources: [{ resource: "memory://one" }, { resource: "memory://two" }],
    });
    expect(
      parseOkfFrontmatter(
        content.replace(
          'last_contact_at: "2026-08-25"',
          'last_contact_at: "2026-08-26"',
        ),
      ).issues[0]?.code,
    ).toBe("invalid_yaml");
  });
  it("accepts OKF v0.2 fields and producer extensions", () => {
    const result = validateOkfDocument(
      `---
type: Project Memory
title: Delivery
status: stable
generated: { by: linger-memory/1, at: 2026-09-08T10:00:00+08:00 }
verified: []
sources:
  - resource: memory://session/1
graph:
  id: delivery
---

# Delivery
`,
      { relativePath: "projects/delivery.md" },
    );

    expect(result).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects invalid optional OKF families when present", () => {
    const result = validateOkfDocument(
      `---
type: Memory
status: active
stale_after: 2026-09-09
sources:
  - title: Missing resource
---
`,
      { relativePath: "memory.md" },
    );

    expect(result.issues.map(({ code }) => code)).toEqual([
      "invalid_sources",
      "invalid_status",
      "invalid_stale_after",
    ]);
  });

  it("enforces v0.2 only on the bundle root index", () => {
    const root = validateOkfDocument("# Index\n", {
      relativePath: "index.md",
      requireRootVersion: true,
    });
    const nested = validateOkfDocument("# Topics\n", {
      relativePath: "topics/index.md",
      requireRootVersion: true,
    });

    expect(root.valid).toBe(false);
    expect(nested.valid).toBe(true);
    expect(
      validateOkfDocument(setOkfRootIndexVersion("# Index\n"), {
        relativePath: "index.md",
        requireRootVersion: true,
      }).valid,
    ).toBe(true);
  });

  it("repairs common generated frontmatter scalar quote mistakes", () => {
    const content = `---
type: Project Memory
title: Project: Delivery"
description: "Daily summary from generated memory
status: stable
sources:
  - title: Session: 2026-09-08 planning
    resource: memory://session/1
---

# Project: Delivery
`;

    expect(
      validateOkfDocument(content, { relativePath: "projects/delivery.md" }),
    ).toMatchObject({ valid: true, issues: [] });
    expect(parseOkfFrontmatter(content).fields).toMatchObject({
      title: "Project: Delivery",
      description: "Daily summary from generated memory",
      sources: [{ title: "Session: 2026-09-08 planning" }],
    });
    expect(normalizeOkfMarkdown(content)).toContain(
      'title: "Project: Delivery"',
    );
    expect(normalizeOkfMarkdown(content)).toContain(
      'description: "Daily summary from generated memory"',
    );
    expect(normalizeOkfMarkdown(content)).toContain(
      '  - title: "Session: 2026-09-08 planning"',
    );
  });

  it.each(["'", '"'])(
    "preserves valid %s quoted scalars with trailing comments",
    (quote) => {
      const content = `---\ntype: ${quote}Client Memory${quote} # entity: organization\nid: ${quote}client_example${quote} # stable identity\n---\n`;
      expect(normalizeOkfMarkdown(content)).toBe(content);
      expect(parseOkfFrontmatter(content).fields).toMatchObject({
        type: "Client Memory",
        id: "client_example",
      });
    },
  );
});
