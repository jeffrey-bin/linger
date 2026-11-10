import { describe, expect, it } from "vitest";

import { parseMemoryMarkdown } from "../../src/memory/markdown.js";

describe("parseMemoryMarkdown", () => {
  it("repairs an unquoted colon-bearing source title", () => {
    const parsed = parseMemoryMarkdown(`---
type: Project Memory
title: "Project Memory: Agent harness engineering"
sources:
  - title: Session: 2026-06-05 Bo's sharing session
    resource: alice/evidence/2026-09-02/sessions/room_1.md
---

# Project Memory: Agent harness engineering

Current project state.
`);

    expect(parsed.title).toBe("Project Memory: Agent harness engineering");
    expect(parsed.metadata.sources).toEqual([
      {
        title: "Session: 2026-06-05 Bo's sharing session",
        resource: "alice/evidence/2026-09-02/sessions/room_1.md",
      },
    ]);
    expect(parsed.summary).toBe("Current project state.");
  });

  it("summarizes with the frontmatter description in one short sentence", () => {
    const parsed = parseMemoryMarkdown(`---
type: Project Memory
title: Hardware prototype
description: The team validates the design with a 3D prototype first. CNC waits.
---

# Hardware prototype

## Project Summary

Build every possible option.
`);

    expect(parsed.summary).toBe(
      "The team validates the design with a 3D prototype first.",
    );
  });

  it("falls back to the first body paragraph, whatever its heading says", () => {
    const parsed = parseMemoryMarkdown(`---
type: Client Memory
title: "Client: Acme"
description: "  "
---

# Client: Acme

## Basic Info

Acme is evaluating the hardware prototype.

## Long-Term One-line Summary

Acme requires a validated quotation before production.
`);

    expect(parsed.summary).toBe("Acme is evaluating the hardware prototype.");
  });

  it("limits fallback body summaries to 180 characters", () => {
    const body = new Array(80).fill("context").join(" ");
    const parsed = parseMemoryMarkdown(`# Long note\n\n${body}`);

    expect(Array.from(parsed.summary).length).toBeLessThanOrEqual(180);
    expect(parsed.summary.endsWith("...")).toBe(true);
    expect(parsed.summary).not.toContain("# Long note");
  });

  it("keeps a short first sentence instead of merging the next sentence", () => {
    expect(
      parseMemoryMarkdown("# API status\n\nAPI is stable. Migration follows.")
        .summary,
    ).toBe("API is stable.");
  });

  it("falls back through description and title when the body has no prose", () => {
    expect(
      parseMemoryMarkdown(`---
title: Empty note
description: Concise metadata description.
---

# Empty note
`).summary,
    ).toBe("Concise metadata description.");
    expect(parseMemoryMarkdown("# Title only\n").summary).toBe("Title only");
  });
});
