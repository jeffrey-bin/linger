import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import {
  PERSONAL_WIKI_NODE_TYPES,
  personalWikiSectionFormat,
  personalWikiSectionUpdate,
  type PersonalWikiNodeType,
} from "../../src/llm-wiki/personal-wiki-node-types.js";
import {
  finalizeEntityChangeLog,
  renderWikiPage,
  strictWikiPageSchema,
  validateWikiPageTemplate,
  WikiPageAuthoringError,
  wikiPageForModel,
  wikiPageFromStrictPayload,
  wikiPageSchema,
} from "../../src/llm-wiki/wiki-page-template.js";

const references = new Map([
  ["raw:S1", "teamhub://rooms/room_one/messages/message_1"],
  ["raw:S2", "teamhub://documents/doc_two/versions/v2"],
]);
function fixture(type = "topic") {
  const definition = PERSONAL_WIKI_NODE_TYPES.get(type as "topic")!;
  const path =
    type === "session"
      ? "sessions/2026-09-28/room_one.md"
      : type === "daily"
        ? "me/daily/2026-09-28.md"
        : type === "weekly"
          ? "me/weekly/2026-09-28.md"
          : `${definition.directory}/alpha.md`;
  const fields = Object.fromEntries(
    definition.fields
      .filter((f) => f !== "sources")
      .map((f) => [
        f,
        f === "aliases"
          ? []
          : f === "date" || f === "week_start"
            ? "2026-09-28"
            : f === "source_kind"
              ? "room"
              : f === "session_id"
                ? "room_one"
                : "Alpha",
      ]),
  );
  const payload = {
    title: "Alpha",
    description: "Grounded summary.",
    fields,
    sections: authoredSections(
      definition,
      "Supported finding. [[source:raw:S2]]",
    ),
    source_refs: ["raw:S2"],
    relations: {},
    ...(definition.kind === "record" ? { source_readable: true } : {}),
  };
  return { definition, path, payload };
}

/** Section input in the shape each section's update rule or format expects. */
function authoredSections(
  definition: PersonalWikiNodeType,
  text: string,
): Record<string, unknown> {
  return Object.fromEntries(
    definition.sections.flatMap((heading): [string, unknown][] => {
      const update = personalWikiSectionUpdate(definition, heading);
      if (update === "generated") return [];
      const format = personalWikiSectionFormat(definition, heading);
      if (format === "list") return [[heading, [text]]];
      if (format === "outcomes")
        return [[heading, [{ kind: "decision", text, evidence: text }]]];
      if (format === "actions") return [[heading, [{ text, evidence: text }]]];
      return [
        [
          heading,
          update === "summary"
            ? { text, reason: "first write" }
            : update === "items"
              ? [{ text }]
              : text,
        ],
      ];
    }),
  );
}

describe("registry-owned Wiki page JSON schemas", () => {
  it.each(["Meeting Summary", "Main Topics"])(
    "requires a bound citation inside every %s topic",
    (heading) => {
      const { definition, path, payload } = fixture("session");
      const valid =
        "### First\n\nFirst observation. [[source:raw:S2]]\n\n### Second\n\n#### Details\n\nSecond observation. [[source:raw:S2]]";
      payload.sections[heading] = valid;
      const markdown = renderWikiPage(path, payload, references);
      expect(markdown.match(/^## .+$/gm)).toEqual(
        definition.sections.map((s) => `## ${s}`),
      );
      for (const invalid of [
        "Observation without a citation.",
        valid.replace(
          "First observation. [[source:raw:S2]]",
          "First observation.",
        ),
        "### First\n\nObservation.\n\n### Second\n\nBoth topics are covered. [[source:raw:S2]]",
        "### First\n\nObservation. `[[source:raw:S2]]`",
        "### First\n\nObservation.\n\n~~~md\n[[source:raw:S2]]\n~~~",
        "### First\n\nObservation. <!-- [[source:raw:S2]] -->",
        "### First [[source:raw:S2]]\n\nObservation without a body citation.",
        "### First\n\nCited. [[source:raw:S2]]\n\n  ### Second\n\nUncited.",
      ]) {
        expect(() =>
          renderWikiPage(
            path,
            {
              ...payload,
              sections: { ...payload.sections, [heading]: invalid },
            },
            references,
          ),
        ).toThrow(/missing citation/);
      }
      // The persisted-page review must enforce the same rule, not only JSON writes.
      expect(() =>
        validateWikiPageTemplate(
          path,
          markdown.replace("Second observation. [R1]", "Second observation."),
          references,
        ),
      ).toThrow(/missing citation/);
    },
  );

  it("renders every Session section shape with application-owned labels", () => {
    const { path, payload } = fixture("session");
    payload.sections = {
      "Objective Summary": "Shipped the plan. [[source:raw:S2]]",
      Keywords: ["Alpha", "\u9879\u76ee  launch\nplan"],
      "Meeting Summary": "### Plan\n\nAgreed. [[source:raw:S2]]",
      "Main Topics": "",
      "Decisions And Outcomes": [
        {
          kind: "decision",
          text: "Ship Friday",
          evidence: "Ann, 10:02 [[source:raw:S2]]",
        },
        { kind: "completed", text: "Draft\n  done", evidence: "Bob" },
      ],
      "Action Items": [
        {
          text: "Send deck",
          owner: "Ann",
          priority: "high",
          evidence: "Ann, 10:05 [[source:raw:S2]]",
        },
        {
          text: "Book room",
          resources: "Calendar",
          deadline: "Friday",
          evidence: "Bob",
        },
      ],
      Pattern: [],
    };
    const markdown = renderWikiPage(path, payload, references);
    expect(markdown.slice(markdown.indexOf("# Alpha"))).toBe(
      [
        "# Alpha",
        "## Objective Summary\n\nShipped the plan. [R1]",
        "## Keywords\n\n- Alpha\n- \u9879\u76ee launch plan",
        "## Meeting Summary\n\n### Plan\n\nAgreed. [R1]",
        "## Main Topics\n\nNone observed.",
        "## Decisions And Outcomes\n\n- Decision: Ship Friday\n  - Evidence: Ann, 10:02 [R1]\n- Completed: Draft done\n  - Evidence: Bob",
        "## Action Items\n\n- Action: Send deck\n  - Owner: Ann\n  - Priority: high\n  - Evidence: Ann, 10:05 [R1]\n- Action: Book room\n  - Deadline: Friday\n  - Resources: Calendar\n  - Evidence: Bob",
        "## Pattern\n\nNone observed.",
      ].join("\n\n") + "\n",
    );
    expect(() =>
      validateWikiPageTemplate(path, markdown, references),
    ).not.toThrow();
  });

  it("rejects Session items outside their declared shapes", () => {
    const { path, payload } = fixture("session");
    const outcome = { kind: "decision", text: "Ship", evidence: "Ann" };
    const action = { text: "Send", evidence: "Ann" };
    for (const sections of [
      { "Decisions And Outcomes": [{ ...outcome, kind: "proposal" }] },
      { "Decisions And Outcomes": [{ ...outcome, confidence: "high" }] },
      { "Decisions And Outcomes": [{ kind: "decision", text: "Ship" }] },
      { "Action Items": [{ ...action, priority: "urgent" }] },
      { "Action Items": [{ ...action, status: "open" }] },
      { "Action Items": [{ ...action, owner: "" }] },
      { "Action Items": [{ text: "Send" }] },
      { Keywords: ["a", "b", "c", "d", "e", "f"] },
      { Keywords: "Alpha" },
      { "Main Topics": [] },
      { "Objective Summary": "" },
    ]) {
      expect(() =>
        renderWikiPage(
          path,
          { ...payload, sections: { ...payload.sections, ...sections } },
          references,
        ),
      ).toThrow(/schema/);
    }
    for (const bad of [
      "## Heading",
      "Fake [R1]",
      "teamhub://rooms/x/messages/message_1",
    ])
      expect(() =>
        renderWikiPage(
          path,
          {
            ...payload,
            sections: {
              ...payload.sections,
              "Action Items": [{ ...action, evidence: bad }],
            },
          },
          references,
        ),
      ).toThrow(/R-labels/);
  });

  it("rejects an unreadable Session source and requires the flag", () => {
    const { path, payload } = fixture("session");
    expect(() =>
      renderWikiPage(path, { ...payload, source_readable: false }, references),
    ).toThrow(/Read its full original text/);
    const { source_readable: _omitted, ...withoutFlag } = payload;
    expect(() => renderWikiPage(path, withoutFlag, references)).toThrow(
      /schema/,
    );
    // The flag is authoring input only; persisted pages never carry it.
    expect(renderWikiPage(path, payload, references)).not.toContain(
      "source_readable",
    );
  });

  it("classifies authoring errors by code, not by message", () => {
    const { path, payload } = fixture("session");
    const codeOf = (input: unknown) => {
      try {
        renderWikiPage(path, input, references);
      } catch (error) {
        expect(error).toBeInstanceOf(WikiPageAuthoringError);
        return (error as WikiPageAuthoringError).code;
      }
      throw new Error("expected a rejection");
    };
    expect(codeOf({ ...payload, source_refs: ["raw:S1"] })).toBe(
      "invalid_evidence_reference",
    );
    expect(codeOf({ ...payload, source_refs: ["raw:S404"] })).toBe(
      "invalid_evidence_reference",
    );
    expect(codeOf({ ...payload, source_readable: false })).toBe(
      "invalid_node_structure",
    );
    expect(codeOf({ ...payload, extra: true })).toBe("invalid_node_structure");
  });

  it("allows empty Session content and ignores headings inside cited code examples", () => {
    const { path, payload } = fixture("session");
    payload.sections["Meeting Summary"] = "";
    payload.sections["Main Topics"] =
      "### One topic\n\nExplanation. [[source:raw:S2]]\n\n````md\n### Example heading\n```\n````";
    expect(() => renderWikiPage(path, payload, references)).not.toThrow();
  });

  it("normalizes only unambiguous escaped layout without rewriting content or code", () => {
    const { path, payload } = fixture("session");
    payload.sections["Main Topics"] =
      "### One\\n\\nUncited first topic.\\n\\n### Two\\n\\nFinding [[source:raw:S2]]";
    expect(() => renderWikiPage(path, payload, references)).toThrow(
      /missing citation/,
    );
    payload.sections["Main Topics"] =
      "### One\\n\\nExplain `\\n\\n` as a code example. [[source:raw:S2]]\\n\\n### Two\\n\\nSecond fact. [[source:raw:S2]]";
    const markdown = renderWikiPage(path, payload, references);
    expect(markdown).toContain(
      "### One\n\nExplain `\\n\\n` as a code example. [R1]\n\n### Two\n\nSecond fact. [R1]",
    );
    expect(payload.sections["Main Topics"]).toContain("### One\\n\\n");
    expect(() =>
      validateWikiPageTemplate(path, markdown, references),
    ).not.toThrow();
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replace("### One\n\nExplain", "### One\\n\\nExplain"),
        references,
      ),
    ).toThrow(/escaped Markdown line breaks/);
    payload.sections["Main Topics"] =
      "### One\n\nCited. [[source:raw:S2]]\\n\\n### Two\\n\\nAmbiguous mixed layout.";
    expect(() => renderWikiPage(path, payload, references)).toThrow(
      /escaped Markdown line breaks/,
    );
  });

  it("supplies original content rules on Session schema fields without limiting body length", async () => {
    const { definition, path, payload } = fixture("session");
    const schema = wikiPageSchema(definition, [...references.keys()]);
    for (const [heading, filename] of [
      ["Meeting Summary", "summary.md"],
      ["Main Topics", "discussion.md"],
    ] as const) {
      const original = await readFile(
        new URL(
          `../../prompts/llm-wiki/personal/session-meeting-note/${filename}`,
          import.meta.url,
        ),
        "utf8",
      );
      expect(schema.properties.sections.properties[heading]).toMatchObject({
        type: "string",
        description: expect.stringContaining(original.trim()),
      });
      expect(schema.properties.sections.properties[heading]).toMatchObject({
        description: expect.stringContaining("H1/H2 must not appear"),
      });
      expect(schema.properties.sections.properties[heading]).toMatchObject({
        description: expect.stringContaining(
          "Fact Coverage Before Abstraction",
        ),
      });
      expect(schema.properties.sections.properties[heading]).not.toHaveProperty(
        "maxLength",
      );
      payload.sections[heading] =
        "- **Concrete detail**: Supported fact. [[source:raw:S2]]\n".repeat(
          500,
        );
    }
    const markdown = renderWikiPage(path, payload, references);
    expect(markdown.match(/Concrete detail/g)).toHaveLength(1000);
    expect(
      wikiPageSchema(fixture("topic").definition).properties.sections.properties
        .Overview,
    ).not.toHaveProperty("description");
  });

  it("requires both Session content views and rejects legacy sections on a new write", () => {
    const { path, payload, definition } = fixture("session");
    expect(definition.sections).toEqual([
      "Objective Summary",
      "Keywords",
      "Meeting Summary",
      "Main Topics",
      "Decisions And Outcomes",
      "Action Items",
      "Pattern",
    ]);
    const markdown = renderWikiPage(path, payload, references);
    expect(markdown.match(/^## .+$/gm)).toEqual(
      definition.sections.map((section) => `## ${section}`),
    );
    const withoutSummary = { ...payload.sections };
    delete withoutSummary["Meeting Summary"];
    expect(() =>
      renderWikiPage(
        path,
        { ...payload, sections: withoutSummary },
        references,
      ),
    ).toThrow(/schema/);
    expect(() =>
      renderWikiPage(
        path,
        {
          ...payload,
          sections: {
            ...payload.sections,
            "Completed Or Resolved": "",
          },
        },
        references,
      ),
    ).toThrow(/schema/);
  });

  it.each(["session"])("requires and preserves the %s Pattern body", (type) => {
    const { path, payload, definition } = fixture(type);
    const sections = {
      ...payload.sections,
      Pattern: [
        "User requested: inspect evidence, compare options, then confirm. [[source:raw:S2]]",
      ],
    };
    const schema = wikiPageSchema(definition, [...references.keys()]);
    expect(schema.properties.sections.required).toContain("Pattern");
    expect(schema.properties.sections.properties.Pattern).toMatchObject({
      description: expect.stringContaining(
        "Reject local choices and inferred styles",
      ),
    });
    expect(schema.properties.sections.properties.Pattern).toMatchObject({
      description: expect.stringContaining("Verify authorship"),
    });
    const markdown = renderWikiPage(path, { ...payload, sections }, references);
    expect(markdown).toContain("## Pattern");
    expect(markdown).toContain(
      "inspect evidence, compare options, then confirm. [R1]",
    );
    expect(() =>
      renderWikiPage(
        path,
        { ...payload, sections: { ...sections, Pattern: [""] } },
        references,
      ),
    ).toThrow(/schema/);
  });

  it.each([...PERSONAL_WIKI_NODE_TYPES.keys()])(
    "renders and reviews %s with the same schema",
    (type) => {
      const { path, payload, definition } = fixture(type);
      const markdown = renderWikiPage(path, payload, references);
      expect(markdown).toContain(
        '"resource": "teamhub://documents/doc_two/versions/v2"',
      );
      expect(markdown).toContain("Supported finding. [R1]");
      expect(markdown).not.toContain("[[source:");
      expect(() =>
        validateWikiPageTemplate(path, markdown, references),
      ).not.toThrow();
      const authored = Object.keys(payload.sections);
      expect(
        wikiPageSchema(definition, [...references.keys()]).properties.sections
          .required,
      ).toEqual(authored);
      for (const heading of authored) {
        const sections = { ...payload.sections };
        delete sections[heading];
        expect(() =>
          renderWikiPage(path, { ...payload, sections }, references),
        ).toThrow(/schema/);
      }
    },
  );

  it("rejects missing fields, unknown properties, duplicate/unknown references and unsupported relations", () => {
    const { path, payload } = fixture();
    for (const patch of [
      { fields: {} },
      { extra: true },
      { source_refs: ["raw:S404"] },
      { source_refs: ["raw:S1", "raw:S1"] },
      { relations: { unregistered: ["x"] } },
    ]) {
      expect(() =>
        renderWikiPage(path, { ...payload, ...patch }, references),
      ).toThrow(/schema/);
    }
    const session = fixture("session");
    expect(() =>
      renderWikiPage(
        session.path,
        { ...session.payload, source_refs: ["raw:S1"] },
        references,
      ),
    ).toThrow(/not selected/);
    // An entity page lists every catalog source its text cites.
    expect(
      renderWikiPage(path, { ...payload, source_refs: ["raw:S1"] }, references),
    ).toMatch(/"id": "R2",\s+"resource": "teamhub:\/\/documents\/doc_two/u);
    expect(() =>
      renderWikiPage(
        path,
        {
          ...payload,
          sections: {
            ...payload.sections,
            Overview: { text: "Fake [R1]", reason: "first write" },
          },
        },
        references,
      ),
    ).toThrow(/R-labels/);
  });

  it("does not guess an unbound citation, accept reordered sections or a wrong raw version", () => {
    const { path, payload } = fixture();
    const markdown = renderWikiPage(path, payload, references);
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replaceAll("[R1]", "[R8]"),
        references,
      ),
    ).toThrow(/unbound/);
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replace("## Overview", "## Unexpected"),
        references,
      ),
    ).toThrow(/H2 order/);
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replace("versions/v2", "versions/fake"),
        references,
      ),
    ).toThrow(/catalog/);
  });

  it("rejects unknown graph extensions and missing relation metadata", () => {
    const { path, payload } = fixture();
    const markdown = renderWikiPage(path, payload, references);
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replace(
          '  "relations": {},',
          '  "graph.about": [],\n  "relations": {},',
        ),
        references,
      ),
    ).toThrow(/unexpected frontmatter fields/);
    expect(() =>
      validateWikiPageTemplate(
        path,
        markdown.replace('  "relations": {},\n', ""),
        references,
      ),
    ).toThrow(/relations must be an object/);
  });

  it("rejects conflicting routed identities", () => {
    const { path, payload } = fixture("session");
    expect(() =>
      renderWikiPage(
        path,
        { ...payload, fields: { ...payload.fields, date: "2026-09-27" } },
        references,
      ),
    ).toThrow(/identity/);
  });
});

describe("entity section update rules", () => {
  const path = "projects/alpha.md";
  const created = new Date("2026-10-01T00:00:00Z");
  const updated = new Date("2026-10-17T00:00:00Z");
  const page = (
    sections: Record<string, unknown>,
    sourceRefs = ["raw:S1"],
  ) => ({
    title: "Alpha",
    description: "Grounded summary.",
    fields: { project_name: "Alpha", project_slug: "alpha", aliases: [] },
    sections,
    source_refs: sourceRefs,
    relations: {},
  });
  const kept = {
    "Project Summary": { keep: true },
    "Project Directions": { keep: true },
    Related: [],
    "Open Items": [],
    "Closed Items": [],
  };
  const first = (closed: unknown[] = []) =>
    renderWikiPage(
      path,
      page({
        "Project Summary": {
          text: "Goal one. [[source:raw:S1]]",
          reason: "The kickoff set the goal.",
        },
        "Project Directions": {
          text: "##### Direction: Core\n\nBuild it. [[source:raw:S1]]\n\nLast updated: 2026-10-01",
          reason: "The kickoff set the direction.",
        },
        Related: [],
        "Open Items": [
          { text: "Send the quote to Bob [[source:raw:S1]]" },
          { text: "Confirm the launch date [[source:raw:S1]]" },
          { text: "Prepare designs [[source:raw:S1]]" },
        ],
        "Closed Items": closed,
      }),
      references,
      undefined,
      created,
    );
  const update = (
    previous: string,
    sections: Record<string, unknown>,
    sourceRefs?: string[],
  ) =>
    renderWikiPage(
      path,
      page({ ...kept, ...sections }, sourceRefs),
      references,
      previous,
      updated,
    );
  const items = (markdown: string) =>
    JSON.parse(markdown.split("\n---\n")[0]!.slice(4)).items as Record<
      string,
      string[]
    >;
  const changeLog = (markdown: string) =>
    markdown.split("## Change Log\n\n")[1]!;

  it("publishes one entry across writes from multiple source batches and retries", () => {
    const base = first();
    const batchOne = update(base, {
      "Project Summary": {
        text: "A new goal. [[source:raw:S1]]",
        reason: "A launch was approved.",
      },
      "Open Items": [{ text: "Contact the supplier [[source:raw:S1]]" }],
    });
    const batchTwo = update(batchOne, {
      "Closed Items": [{ text: "Approval received [[source:raw:S1]]" }],
    });
    const result = finalizeEntityChangeLog(path, batchTwo, base);
    expect(changeLog(result).trim().split("\n")).toEqual([
      "- 2026-10-17 Updated Project Summary · Open Items: 1 added · Closed Items: 1 added — A launch was approved.",
      "- 2026-10-01 Created.",
    ]);
    expect(finalizeEntityChangeLog(path, result, base)).toBe(result);
    expect(changeLog(finalizeEntityChangeLog(path, batchTwo, undefined))).toBe(
      "- 2026-10-17 Created.\n",
    );
    const secondRefresh = update(result, {
      "Open Items": [{ text: "Another item [[source:raw:S1]]" }],
    });
    const second = finalizeEntityChangeLog(path, secondRefresh, result);
    expect(changeLog(second).match(/^- 2026-10-17 /gm)).toHaveLength(2);
  });

  it("drops intermediate changes that revert, citation renumbering and render timestamps", () => {
    const base = update(first(), {}, ["raw:S1", "raw:S2"]);
    const changed = update(base, {
      "Project Summary": {
        text: "Changed. [[source:raw:S1]]",
        reason: "Provisional.",
      },
    });
    const reverted = update(
      changed,
      {
        "Project Summary": {
          text: "Goal one. [[source:raw:S1]]",
          reason: "Reverted.",
        },
      },
      ["raw:S2", "raw:S1"],
    );
    expect(finalizeEntityChangeLog(path, reverted, base)).toBe(base);
  });

  it("logs no entry when only the selected sources change", () => {
    const base = first();
    const resourced = update(base, {}, ["raw:S1", "raw:S2"]);
    expect(finalizeEntityChangeLog(path, resourced, base)).toBe(base);
  });

  it("keeps unmentioned items and logs retractions, updates and additions", () => {
    const before = first();
    expect(before).toContain("- 2026-10-01 Created.");
    expect(items(before)).toEqual({
      Related: [],
      "Open Items": ["i1", "i2", "i3"],
      "Closed Items": [],
    });
    const after = update(
      before,
      {
        "Open Items": [
          { id: "i1", retracted: "the quote was sent" },
          { id: "i3", text: "Prepare final designs [[source:raw:S2]]" },
          { text: "Add multilingual support [[source:raw:S2]]" },
        ],
        "Closed Items": [{ text: "Quote sent to Bob [[source:raw:S2]]" }],
      },
      ["raw:S2"],
    );
    expect(() =>
      validateWikiPageTemplate(path, after, references),
    ).not.toThrow();
    expect(items(after)).toMatchObject({
      "Open Items": ["i2", "i3", "i4"],
      "Closed Items": ["i5"],
    });
    expect(after).toContain(
      "- Confirm the launch date [R2]\n- Prepare final designs [R1]\n- Add multilingual support [R1]",
    );
    expect(changeLog(after)).toBe(
      [
        "- 2026-10-17 Retracted from Open Items: Send the quote to Bob (the quote was sent)",
        "- 2026-10-17 Updated in Open Items: Prepare final designs",
        "- 2026-10-17 Added 1 entry to Open Items.",
        "- 2026-10-17 Added 1 entry to Closed Items.",
        "- 2026-10-01 Created.",
        "",
      ].join("\n"),
    );
  });

  it("rejects an unknown or repeated item ID", () => {
    const before = first();
    expect(items(update(before, {}))["Open Items"]).toEqual(["i1", "i2", "i3"]);
    expect(() => update(before, { "Open Items": [{ id: "i9" }] })).toThrow(
      /i9 is unknown or repeated/,
    );
    expect(() =>
      update(before, { "Open Items": [{ id: "i3" }, { id: "i3" }] }),
    ).toThrow(/i3 is unknown or repeated/);
  });

  it("caps a growing section and merges its oldest entries into one summary", () => {
    const closed = Array.from({ length: 20 }, (_, index) => ({
      text: `Closed result ${index + 1} [[source:raw:S1]]`,
    }));
    const before = first(closed);
    expect(items(before)["Closed Items"]).toHaveLength(20);
    const extra = { text: "Closed result 21 [[source:raw:S1]]" };
    expect(() => update(before, { "Closed Items": [extra] })).toThrow(
      /Closed Items would have 21 entries; the limit is 20/,
    );
    const after = update(before, {
      "Closed Items": [
        {
          merge: ["i4", "i5"],
          text: "Results 1-2 closed in October [[source:raw:S1]]",
        },
        extra,
      ],
    });
    expect(items(after)["Closed Items"]).toEqual([
      "i24",
      ...Array.from({ length: 18 }, (_, index) => `i${index + 6}`),
      "i25",
    ]);
    expect(after).toContain(
      "## Closed Items\n\n- Results 1-2 closed in October [R1]\n- Closed result 3 [R1]",
    );
    expect(changeLog(after)).toContain(
      "- 2026-10-17 Merged i4, i5 in Closed Items into i24: Results 1-2 closed in October",
    );
    expect(() =>
      update(before, {
        "Closed Items": [
          { merge: ["i4", "i99"], text: "Merged [[source:raw:S1]]" },
        ],
      }),
    ).toThrow(/i99 is unknown or repeated/);
  });

  it("keeps the newest 5 Change Log entries first and drops the rest", () => {
    let markdown = first();
    for (let round = 1; round <= 6; round++)
      markdown = update(markdown, {
        "Project Summary": {
          text: `Goal ${round}. [[source:raw:S1]]`,
          reason: `revision ${round}`,
        },
      });
    const log = changeLog(markdown);
    expect(
      log.startsWith(
        "- 2026-10-17 Rewrote Project Summary: revision 6\n- 2026-10-17 Rewrote Project Summary: revision 5\n",
      ),
    ).toBe(true);
    expect(log.match(/^- /gmu)).toHaveLength(5);
    expect(log).not.toContain("Earlier changes");
    expect(log).not.toContain("Created.");
    expect(log).not.toContain("revision 1\n");
  });

  it("caps a written summary but keeps longer existing text", () => {
    const long = `${"Fact. ".repeat(600)}[[source:raw:S1]]`;
    expect(() =>
      update(first(), {
        "Project Summary": { text: long, reason: "expanded the summary" },
      }),
    ).toThrow(/Project Summary has 3619 characters; the limit is 3000/);
    const legacy = first().replace(
      "Goal one. [R1]",
      `${"Fact. ".repeat(600)}[R1]`,
    );
    expect(update(legacy, {})).toContain("Fact. Fact.");
  });

  it("counts citations toward a written summary", () => {
    const prose = "x".repeat(2990);
    const write = (citations: string) =>
      update(first(), {
        "Project Summary": {
          text: `${prose} ${citations}`,
          reason: "rewrote the summary",
          removed_refs: ["raw:S1"],
        },
      });
    expect(() => write("")).not.toThrow();
    expect(() => write("[[source:raw:S2]]")).toThrow(
      /Project Summary has 3010 characters; the limit is 3000/,
    );
  });

  it("caps one written entry, including a merged summary, and clips Change Log lines", () => {
    const before = first();
    const long = `${"Long detail. ".repeat(40)}[[source:raw:S1]]`;
    expect(() => update(before, { "Open Items": [{ text: long }] })).toThrow(
      /an entry in Open Items has 539 characters; the limit is 500/,
    );
    expect(() =>
      update(before, { "Open Items": [{ id: "i2", text: long }] }),
    ).toThrow(/the limit is 500/);
    expect(() =>
      update(before, {
        "Open Items": [{ merge: ["i1", "i2"], text: long }],
      }),
    ).toThrow(/the limit is 500/);
    const reason = "r".repeat(300);
    const after = update(before, {
      "Project Summary": { text: "Goal two. [[source:raw:S1]]", reason },
    });
    const line = changeLog(after)
      .split("\n")
      .find((entry) => entry.includes("Rewrote"))!;
    expect(line.length).toBe("- 2026-10-17 ".length + 200);
    expect(line.endsWith("…")).toBe(true);
  });

  it("keeps summary text and relabels its citations when the source order changes", () => {
    const after = update(first(), {}, ["raw:S2"]);
    expect(after).toContain(
      '"id": "R2",\n      "resource": "teamhub://rooms/room_one/messages/message_1"',
    );
    expect(after).toContain("## Project Summary\n\nGoal one. [R2]");
    expect(after).toContain("Build it. [R2]");
    expect(after).toContain("- Send the quote to Bob [R2]");
    // Nothing changed, so nothing is added to the Change Log.
    expect(changeLog(after)).toBe("- 2026-10-01 Created.\n");
  });

  it("requires a reason and every earlier citation to rewrite a summary", () => {
    const before = first();
    const rewrite = (summary: unknown) =>
      update(before, { "Project Summary": summary });
    expect(() => rewrite({ text: "Goal two. [[source:raw:S1]]" })).toThrow(
      /must have required property 'reason'/,
    );
    expect(() =>
      rewrite({ text: "Goal two. [[source:raw:S2]]", reason: "new goal" }),
    ).toThrow(/Project Summary no longer has the citation markers raw:S1/);
    expect(
      rewrite({
        text: "Goal two. [[source:raw:S2]]",
        reason: "the goal moved to launch",
        removed_refs: ["raw:S1"],
      }),
    ).toContain(
      "- 2026-10-17 Rewrote Project Summary: the goal moved to launch",
    );
    expect(() =>
      renderWikiPage("projects/beta.md", page(kept), references),
    ).toThrow(/Project Summary has no previous text to keep/);
  });

  // One retry can fix a rewrite only when it learns every issue at once and
  // sees which facts carried the citations it dropped.
  it("reports every summary section that lost citations, quoting what they cited", () => {
    let message = "";
    try {
      update(first(), {
        "Project Summary": {
          text: "Goal two. [[source:raw:S2]]",
          reason: "The goal moved.",
        },
        "Project Directions": {
          text: "Build it now. [[source:S1]]",
          reason: "The plan sped up.",
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'Project Summary no longer has the citation markers raw:S1. The previous text cited them in:\n    "Goal one. [[source:raw:S1]]"',
    );
    expect(message).toContain(
      "Project Directions has the malformed citation [[source:S1]]; write it as [[source:raw:S1]].",
    );
    expect(message).toContain(
      "Project Directions no longer has the citation markers raw:S1",
    );
    expect(message).toContain(
      'or list the ref in "removed_refs" and say why in "reason"',
    );
  });

  // The strict schema decides what the model can write and the renderer what
  // it accepts. A shape only one of them allows is either never written or
  // written and rejected on every step, and the batch never finishes.
  it("accepts exactly the summary shapes the strict schema can generate", () => {
    const strict = new Ajv();
    const cited = "Changed. [[source:raw:S2]]";
    const shapes: Record<string, Record<string, unknown>> = {
      keep: { keep: true },
      text: { text: cited },
      "text and reason": { text: cited, reason: "new evidence" },
      "removed refs": {
        removed_refs: ["raw:S2"],
        reason: "the source was deleted",
        text: "Changed.",
      },
      "removed refs without reason": {
        removed_refs: ["raw:S2"],
        text: "Changed.",
      },
    };
    const mismatches: string[] = [];
    for (const definition of PERSONAL_WIKI_NODE_TYPES.values()) {
      if (definition.kind !== "entity") continue;
      const { path, payload } = fixture(definition.id);
      const previous = renderWikiPage(path, payload, references);
      const summaries = definition.sections.filter(
        (heading) =>
          personalWikiSectionUpdate(definition, heading) === "summary",
      );
      for (const existing of [true, false]) {
        const sectionSchemas = (
          strictWikiPageSchema(definition, { existing }) as {
            properties: {
              sections: { properties: Record<string, object> };
            };
          }
        ).properties.sections.properties;
        for (const [name, shape] of Object.entries(shapes)) {
          // A new page cites no earlier source it could remove.
          if (!existing && "removed_refs" in shape) continue;
          const generable = summaries.every((heading) =>
            strict.validate(sectionSchemas[heading]!, shape),
          );
          const sections = {
            ...payload.sections,
            ...Object.fromEntries(summaries.map((heading) => [heading, shape])),
          };
          let accepted = true;
          try {
            renderWikiPage(
              path,
              wikiPageFromStrictPayload(definition, {
                ...payload,
                sections,
                relations: [],
              }),
              references,
              existing ? previous : undefined,
            );
          } catch (error) {
            if (!(error instanceof WikiPageAuthoringError)) throw error;
            accepted = false;
          }
          if (generable !== accepted)
            mismatches.push(
              `${definition.id}${existing ? "" : " (new)"} ${name}: generable ${generable}, accepted ${accepted}`,
            );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("restructures a page written before tracked sections without dropping its sources", () => {
    const legacy = `---\n${JSON.stringify(
      {
        type: "Project",
        title: "Alpha",
        description: "Grounded summary.",
        project_name: "Alpha",
        project_slug: "alpha",
        aliases: [],
        status: "stable",
        sources: [
          { id: "R1", resource: "teamhub://rooms/room_one/messages/message_1" },
          { id: "R2", resource: "teamhub://documents/doc_two/versions/v2" },
        ],
        relations: {},
      },
      null,
      2,
    )}\n---\n\n# Alpha\n\n## Project Summary\n\nGoal one. [R1]\n\n## Current Goal\n\nShip. [R2]\n\n## Open Items\n\n- Old item [R1]\n\n## Change Log\n\n- 2026-09-01 Started the project. [R1]\n`;
    const sections = {
      "Project Summary": {
        text: "Goal one. Ship. [[source:raw:S1]] [[source:raw:S2]]",
        reason: "merged Current Goal into the summary",
      },
      "Project Directions": {
        text: "None observed.",
        reason: "nothing about directions yet",
      },
      Related: [],
      "Open Items": [{ text: "Old item [[source:raw:S1]]" }],
      "Closed Items": [],
    };
    const after = update(legacy, sections);
    expect(changeLog(after)).toBe(
      "- 2026-10-17 Adopted tracked sections.\n- 2026-09-01 Started the project. [R1]\n",
    );
    expect(items(after)["Open Items"]).toEqual(["i1"]);
    expect(() =>
      update(legacy, {
        ...sections,
        "Project Summary": {
          text: "Goal one. [[source:raw:S1]]",
          reason: "merged Current Goal into the summary",
        },
      }),
    ).toThrow(/restructuring this page dropped raw:S2/);
  });

  it("lists only the sources the page selects or still cites", () => {
    const listed = first().replace(
      '"sources": [\n    {\n      "id": "R1",\n      "resource": "teamhub://rooms/room_one/messages/message_1"\n    }\n  ],',
      '"sources": [\n    {\n      "id": "R1",\n      "resource": "teamhub://rooms/room_one/messages/message_1"\n    },\n    {\n      "id": "R2",\n      "resource": "teamhub://documents/doc_two/versions/v2"\n    }\n  ],',
    );
    expect(listed).toContain('"id": "R2"');
    expect(update(listed, {})).not.toContain("doc_two");
    const cited = update(listed, {
      "Open Items": [{ text: "Review the spec [[source:raw:S2]]" }],
    });
    expect(cited).toContain(
      '"resource": "teamhub://documents/doc_two/versions/v2"',
    );
    expect(update(cited, {})).toContain("doc_two");
    expect(update(listed, {}, ["raw:S1", "raw:S2"])).toContain("doc_two");
  });

  it("treats a page whose entries no longer match their IDs as untracked", () => {
    const before = first();
    const edited = before.replace("- Prepare designs [R1]\n", "");
    expect(() => validateWikiPageTemplate(path, edited, references)).toThrow(
      /tracked items do not match the Open Items entries/,
    );
    const after = update(edited, {
      "Open Items": [{ text: "Confirm the launch date [[source:raw:S1]]" }],
    });
    expect(items(after)["Open Items"]).toEqual(["i1"]);
    expect(changeLog(after)).toContain(
      "- 2026-10-17 Adopted tracked sections.",
    );
  });
});

describe("the page a writer sees", () => {
  const path = "contacts/alpha.md";
  const reason = "first write";
  const contact = (history: number) =>
    renderWikiPage(
      path,
      {
        title: "Alpha",
        description: "Grounded summary.",
        fields: { contact_name: "Alpha", organization: "Acme", aliases: [] },
        sections: {
          "Basic Info": { text: "Works at Acme. [[source:raw:S1]]", reason },
          "Relationship Context": {
            text: "A client. [[source:raw:S2]]",
            reason,
          },
          "Collaboration Style": { text: "Direct. [[source:raw:S1]]", reason },
          "Needs And Interests": { text: "Speed. [[source:raw:S1]]", reason },
          Related: [],
          "Interaction History": Array.from({ length: history }, (_, i) => ({
            text: `Call ${i + 1} [[source:raw:S${(i % 2) + 1}]]`,
          })),
        },
        source_refs: ["raw:S1", "raw:S2"],
        relations: {},
      },
      references,
      undefined,
      new Date("2026-10-01T00:00:00Z"),
    );

  it("leaves out what the application writes and cites with raw refs", () => {
    const view = wikiPageForModel(path, contact(3), references);
    expect(view).not.toMatch(
      /"sources"|"items"|"generated"|## Change Log|\[R\d\]/,
    );
    expect(view).toContain('"contact_name": "Alpha"');
    expect(view).toContain("Works at Acme. [[source:raw:S1]]");
    expect(view).toContain(
      "## Interaction History\n\n- [i1] Call 1 [[source:raw:S1]]\n- [i2] Call 2 [[source:raw:S2]]\n- [i3] Call 3 [[source:raw:S1]]",
    );
  });

  it("shows a long history's newest entries first, and its oldest near the limit", () => {
    const history = (count: number) =>
      wikiPageForModel(path, contact(count), references)
        .split("## Interaction History\n\n")[1]!
        .trim()
        .split("\n");
    // Entries are listed newest first, so i1 is the newest.
    expect(history(12)).toEqual([
      ...Array.from({ length: 8 }, (_, i) =>
        expect.stringMatching(`^- \\[i${i + 1}\\] Call ${i + 1} `),
      ),
      "(4 older entries are not shown and stay unchanged.)",
    ]);
    expect(history(19)).toEqual([
      ...Array.from({ length: 8 }, (_, i) =>
        expect.stringMatching(`^- \\[i${i + 1}\\] Call ${i + 1} `),
      ),
      "(8 older entries are not shown and stay unchanged.)",
      ...[17, 18, 19].map((n) =>
        expect.stringMatching(`^- \\[i${n}\\] Call ${n} `),
      ),
    ]);
  });

  it("puts a new history entry on top", () => {
    const keep = { keep: true };
    const next = renderWikiPage(
      path,
      {
        title: "Alpha",
        description: "Grounded summary.",
        fields: { contact_name: "Alpha", organization: "Acme", aliases: [] },
        sections: {
          "Basic Info": keep,
          "Relationship Context": keep,
          "Collaboration Style": keep,
          "Needs And Interests": keep,
          Related: [],
          "Interaction History": [{ text: "Call 4 [[source:raw:S2]]" }],
        },
        source_refs: ["raw:S1", "raw:S2"],
        relations: {},
      },
      references,
      contact(3),
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(
      next.split("## Interaction History\n\n")[1]!.split("\n").slice(0, 2),
    ).toEqual(["- Call 4 [R2]", "- Call 1 [R1]"]);
  });
});
