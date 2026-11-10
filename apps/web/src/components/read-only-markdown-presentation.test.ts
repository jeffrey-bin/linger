import { describe, expect, it } from "vitest";

import {
  isKnowledgeChangeLogHeading,
  prepareReadOnlyMarkdown,
  stripKnowledgeCitations,
} from "./read-only-markdown-presentation";

describe("prepareReadOnlyMarkdown", () => {
  it("hides Room source links in report prose and source-only lists without changing ordinary links", () => {
    const markdown = [
      "## Daily Work",
      "- The plan is ready.[Chat](teamhub://rooms/room_1/messages)[Team](teamhub://rooms/room_2/messages)",
      "- See [the project](../projects/plan.md).",
      "",
      "## Source Sessions",
      "- [Chat](teamhub://rooms/room_1/messages)",
      "- [Task](teamhub://rooms/room_2/messages/message_1)",
      "",
      "## Next",
      "Continue.",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      "## Daily Work\n- The plan is ready.\n- See [the project](../projects/plan.md).\n\n## Next\nContinue.",
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });
  it("hides the Sources section including its nested file list", () => {
    const markdown = [
      "# Project",
      "",
      "Keep the summary.",
      "",
      "## Sources",
      "",
      "- [Internal transcript](../sources/session.md)",
      "",
      "### Source details",
      "",
      "Private source path.",
      "",
      "### Internal files",
      "",
      "Another private source path.",
      "",
      "## Next steps",
      "",
      "Keep the action.",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge", "Project")).toBe(
      "Keep the summary.\n\n## Next steps\n\nKeep the action.",
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });

  it.each(["Source Links", "Source", "sources", "**Sources:**"])(
    "keeps a %j section, which the generator never writes as the source marker",
    (heading) => {
      const markdown = `## ${heading}\n\n- [Plan](plan.md)`;
      expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(markdown);
    },
  );

  it.each(["```", "~~~~"])(
    "preserves source headings in %s code fences",
    (fence) => {
      const markdown = [
        `${fence}md`,
        "## Sources",
        "generated: example",
        "sample.md",
        fence,
        "",
        "## Source code",
        "",
        "Sources of uncertainty remain.",
        "",
        "## Evidence Notes",
        "",
        "A supported business fact.",
      ].join("\n");
      expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(markdown);
    },
  );

  it("does not let code headings end a hidden source section", () => {
    const markdown = [
      "## Sources",
      "",
      "```md",
      "# Example",
      "```",
      "",
      "- hidden-source.md",
      "",
      "## Actions",
      "",
      "Visible action.",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      "## Actions\n\nVisible action.",
    );
  });

  it("keeps one list item per related page", () => {
    const markdown = [
      "## Related",
      "",
      "- [Realtime Voice Interaction](realtime-voice-interaction.md): Live and Recording concerns.",
      "- [Kickoff](../sessions/2026-10-21/capture_session_cd34.md): meeting stays.",
      "- [Realtime Voice Interaction](realtime-voice-interaction.md#scope): context capture.",
      "- [Beer Selection](beer-selection.md): a separate concept.",
      "  - [Realtime Voice Interaction](realtime-voice-interaction.md): nested detail stays.",
      "",
      "## Notes",
      "",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      [
        "## Related",
        "",
        "- [Realtime Voice Interaction](realtime-voice-interaction.md): Live and Recording concerns.",
        "- [Kickoff](../sessions/2026-10-21/capture_session_cd34.md): meeting stays.",
        "- [Beer Selection](beer-selection.md): a separate concept.",
        "  - [Realtime Voice Interaction](realtime-voice-interaction.md): nested detail stays.",
        "",
        "## Notes",
      ].join("\n"),
    );
  });

  it("hides source citations in knowledge previews while retaining code", () => {
    const markdown = [
      "---",
      JSON.stringify({
        type: "Session",
        sources: [
          {
            id: "R1",
            resource: "teamhub://rooms/room_launch/messages/message_a",
          },
          {
            id: "R2",
            resource: "teamhub://documents/document_t/versions/version_t",
          },
        ],
      }),
      "---",
      "",
      "## Meeting Summary",
      "",
      "We ship Friday [R1]. The transcript agrees [R2].",
      "",
      "- Decision: ship",
      "  - Evidence: [R1]",
      "",
      "```",
      "literal [R1]",
      "```",
    ].join("\n");
    const prepared = prepareReadOnlyMarkdown(markdown, "knowledge");

    expect(prepared).toContain("We ship Friday. The transcript agrees.");
    expect(prepared).not.toContain("Evidence: [R1]");
    expect(prepared).toContain("literal [R1]");
    expect(prepared).not.toContain("teamhub://");
  });

  it("keeps the original Markdown for the default presentation", () => {
    const markdown = "---\ntitle: Internal\n---\n# Body";

    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });

  it("hides selected internal sections and their children from knowledge previews", () => {
    const markdown = [
      "# Meeting summary",
      "",
      "Keep the summary.",
      "",
      "## CRM Evidence Cache",
      "",
      "Internal CRM explanation.",
      "",
      "### Client Candidates",
      "",
      "None observed.",
      "",
      "## Workflow Evidence Cache",
      "",
      "Internal workflow explanation.",
      "",
      "## Runtime Evidence",
      "",
      "- No runtime evidence in bundle.",
      "",
      "## Subject Relation Note",
      "",
      "Internal authorization explanation.",
      "",
      "## Decisions",
      "",
      "Keep this decision.",
    ].join("\n");

    expect(
      prepareReadOnlyMarkdown(markdown, "knowledge", undefined, [
        "CRM Evidence Cache",
        "Workflow Evidence Cache",
        "Runtime Evidence",
        "Subject Relation Note",
      ]),
    ).toBe(
      "# Meeting summary\n\nKeep the summary.\n\n## Decisions\n\nKeep this decision.",
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });

  it("removes frontmatter, generated metadata, and Sources for knowledge views", () => {
    const markdown = [
      "---",
      "type: Person Context",
      "title: Casey Example",
      "graph:",
      "  id: casey-example",
      "---",
      "",
      "# generated: { by: openwiki, at: 2026-09-15 }",
      "",
      "# Casey Example",
      "",
      "Human-readable details.",
      "",
      "## Sources",
      "",
      "- internal.md",
      "",
      "## Preferences",
      "",
      "Compact status reports.",
    ].join("\n");

    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      [
        "# Casey Example",
        "",
        "Human-readable details.",
        "",
        "## Preferences",
        "",
        "Compact status reports.",
      ].join("\n"),
    );
  });

  it("removes a duplicated document title and restores inline links", () => {
    const markdown = [
      "# Project Memory: Hardware Prototype Development",
      "",
      "- `[Prototype validation](#direction-prototype-validation)`: Validate the prototype.",
    ].join("\n");

    expect(
      prepareReadOnlyMarkdown(
        markdown,
        "knowledge",
        "Project Memory: Hardware Prototype Development",
      ),
    ).toBe(
      "- [Prototype validation](#direction-prototype-validation): Validate the prototype.",
    );
  });

  it.each([
    "# A different title\n\nBody.",
    "## Project\n\nBody.",
    "Introduction.\n\n# Project\n\nBody.",
    "```md\n# Project\n```",
  ])(
    "preserves headings that are not a duplicate leading title: %s",
    (markdown) => {
      expect(prepareReadOnlyMarkdown(markdown, "knowledge", "Project")).toBe(
        markdown,
      );
    },
  );

  it("only removes the leading repeated title after metadata", () => {
    const markdown =
      "---\ntitle: Project\n---\n\n# PROJECT\n\nBody.\n\n## Project\n\nMore.";
    expect(prepareReadOnlyMarkdown(markdown, "knowledge", "Project")).toBe(
      "Body.\n\n## Project\n\nMore.",
    );
  });

  it.each(["```", "~~~~"])(
    "leaves real code and %s fenced examples intact",
    (fence) => {
      const markdown = [
        `${fence}md`,
        "- `[Example](#example)`: documentation example",
        fence,
        "",
        "Use `[Example](#example)` or `pnpm dev`.",
        "",
        "- `[External](https://example.test)`: a code sample",
      ].join("\n");
      expect(prepareReadOnlyMarkdown(markdown, "knowledge", "Example")).toBe(
        markdown,
      );
    },
  );
});

describe("OpenWiki human-readable evidence", () => {
  it("hides citation-only evidence lines and labels, not evidence prose or code", () => {
    const markdown = [
      "---",
      'okf_version: "0.2"',
      "---",
      "",
      "# Meeting",
      "",
      "Readable summary.",
      "",
      "Evidence: [R1]",
      "",
      "- Decision: Ship the beta.",
      "  - Evidence: [R2], [R3]",
      "",
      "Evidence: [R1] confirms this decision.",
      "",
      "```md",
      "Evidence: [R4]",
      "```",
      "",
      "`Evidence: [R5]`",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge", "Meeting")).toBe(
      "Readable summary.\n\n- Decision: Ship the beta.\n\nEvidence: confirms this decision.\n\n```md\nEvidence: [R4]\n```\n\n`Evidence: [R5]`",
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });
});

describe("Wiki citation labels", () => {
  it.each([
    ["Casey leads hardware [R1].", "Casey leads hardware."],
    ["Casey leads hardware [R1, R2] today.", "Casey leads hardware today."],
    ["Casey leads hardware [R1][R3].", "Casey leads hardware."],
    ["Casey leads [R1], [R2]; then ships.", "Casey leads; then ships."],
    ["Range [R1-R3] covered.", "Range covered."],
    ["Casey leads (R2).", "Casey leads."],
    ["ハードのしさくをたんとう[R1]。", "ハードのしさくをたんとう。"],
    [
      "ハードのしさくをたんとう（R1、R2），フォローする。",
      "ハードのしさくをたんとう，フォローする。",
    ],
    [
      "ハードのしさくをたんとう [R1]，フォローする。",
      "ハードのしさくをたんとう，フォローする。",
    ],
    ["Decided to ship. Evidence: [R1].", "Decided to ship."],
    ["Decided. Evidence: [R2], [R3]. Next step.", "Decided. Next step."],
    ["けつろんはせいりつ。[R1]、[R2]", "けつろんはせいりつ。"],
    ["[R1] Leading label.", "Leading label."],
    ["Escaped \\[R4\\] label.", "Escaped label."],
    // Memory file references from Daily and Weekly reports.
    [
      "みつもりはみてい。[2026-08-25 ハードウェアのぎろん](agent_4b82b28dc268374361479ba8e9c35b2a/evidence/2026-08-25/sessions/room_2116.md)",
      "みつもりはみてい。",
    ],
    [
      "Still open. [memory://timeline/daily/2026-09-09.md; memory://timeline/daily/2026-08-31.md]",
      "Still open.",
    ],
    [
      "Shipped the beta [Daily 2026-10-13](memory://timeline/daily/2026-10-13.md), [Daily 2026-10-20](memory://timeline/daily/2026-10-20.md).",
      "Shipped the beta.",
    ],
  ])("strips %j", (text, expected) => {
    expect(stripKnowledgeCitations(text)).toBe(expected);
  });

  it.each([
    "Model R1 ships.",
    "See [R1](https://example.com/r1).",
    "Footnote [R1]: defined elsewhere.",
    "Room [Q1] stays.",
    "Read [the plan](../projects/plan.md) first.",
    "See [Daily 2026-10-13](https://example.com/daily).",
    "[Daily source](memory://timeline/daily/2026-10-13.md)",
  ])("keeps %j", (text) => {
    expect(stripKnowledgeCitations(text)).toBe(text);
  });

  it("strips list and prose labels but keeps code", () => {
    const markdown = [
      "- 2026-10-01: Added owner [R1].",
      "1. Shipped `[R2]` marker [R3].",
      "",
      "```md",
      "Keep [R4]",
      "```",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      [
        "- 2026-10-01: Added owner.",
        "1. Shipped `[R2]` marker.",
        "",
        "```md",
        "Keep [R4]",
        "```",
      ].join("\n"),
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });
});

describe("Wiki Change Log heading", () => {
  it.each(["Change Log", " Change Log "])("recognizes %j", (title) =>
    expect(isKnowledgeChangeLogHeading(title)).toBe(true),
  );
  it.each([
    "Changelog",
    "change log",
    "**Change Log:**",
    "Journal des modifications",
    "Change Logs of others",
    "Recent changes",
  ])("ignores %j", (title) =>
    expect(isKnowledgeChangeLogHeading(title)).toBe(false),
  );
});

describe("Meeting note Main Topics", () => {
  it("drops topic time ranges only from Main Topics headings", () => {
    const markdown = [
      "## Meeting Summary",
      "",
      "### Launch [00:01:00 - 00:02:00]",
      "",
      "## Main Topics",
      "",
      "### リリースけいかく [00:01:12 - 00:05:30]",
      "",
      "Discussed at [00:02:00 - 00:03:00].",
      "",
      "#### よさん （00:03 – 00:04）",
      "",
      "### Review [00:06 to 00:07]",
      "",
      "### Hiring [じかんみてい]",
      "",
      "```md",
      "### Code [00:01:00 - 00:02:00]",
      "```",
      "",
      "## Action Items",
      "",
      "### Follow up [00:09:00 - 00:10:00]",
    ].join("\n");
    expect(prepareReadOnlyMarkdown(markdown, "knowledge")).toBe(
      [
        "## Meeting Summary",
        "",
        "### Launch [00:01:00 - 00:02:00]",
        "",
        "## Main Topics",
        "",
        "### リリースけいかく",
        "",
        "Discussed at [00:02:00 - 00:03:00].",
        "",
        "#### よさん",
        "",
        "### Review [00:06 to 00:07]",
        "",
        "### Hiring [じかんみてい]",
        "",
        "```md",
        "### Code [00:01:00 - 00:02:00]",
        "```",
        "",
        "## Action Items",
        "",
        "### Follow up [00:09:00 - 00:10:00]",
      ].join("\n"),
    );
    expect(prepareReadOnlyMarkdown(markdown)).toBe(markdown);
  });
});
