import { describe, expect, it } from "vitest";

import {
  dailyReportHasEvidence,
  dailyReportSchema,
  renderDailyReport,
  type DailyReportOutput,
} from "../../src/memory/daily-report.js";
import { parseReportOutput } from "../../src/memory/report-render.js";

const catalog = [
  {
    resource: "teamhub://documents/doc_a/versions/version_a",
    sourceRef: "room_a",
    title: "Hardware [Review]",
  },
  {
    resource: "teamhub://pocket-notes/2026-09-02",
    sourceRef: "pocket-note",
    title: "Pocket Note",
  },
];
const context = {
  date: "2026-09-02",
  memorySubjectKey: "agent_alice",
  hasYesterdayBaseline: true,
  catalog,
  now: new Date("2026-09-02T10:00:00.000Z"),
};

function report(overrides: Partial<DailyReportOutput> = {}): DailyReportOutput {
  return {
    title: "Hardware day",
    description: "Reviewed hardware vendors.",
    source_refs: ["room_a"],
    daily_work: [
      {
        topic: "Hardware",
        text: "Chose vendor A\n  for cost [[source:room_a]].",
      },
    ],
    resolved_items: ["Vendor chosen [[source:room_a]]."],
    unresolved_items: [],
    tomorrow_focus: [
      { text: "Send the purchase order.", suggested: false },
      { text: "Check stock levels.", suggested: true },
    ],
    changes_compared_to_yesterday: ["Moved from research to purchase."],
    pattern: [],
    ...overrides,
  };
}

const link =
  "[Hardware \\[Review\\]](teamhub://documents/doc_a/versions/version_a)";

describe("Daily report rendering", () => {
  it("renders the whole Daily file from the model's fields", () => {
    expect(renderDailyReport(report(), context)).toBe(`---
type: Daily Memory
title: Hardware day
description: Reviewed hardware vendors.
date: 2026-09-02
memory_subject_key: agent_alice
status: stable
generated:
  by: linger-memory/1
  at: 2026-09-02T10:00:00.000Z
sources:
  - title: Hardware [Review]
    resource: teamhub://documents/doc_a/versions/version_a
---

# Hardware day

## Daily Work

- **Hardware**: Chose vendor A for cost ${link}.

## Resolved Items

- Vendor chosen ${link}.

## Unresolved Items

None observed.

## Tomorrow Focus

- Send the purchase order.
- Suggested focus: Check stock levels.

## Changes Compared To Yesterday

- Moved from research to purchase.

## Pattern

None observed.

## Sources

- ${link}
`);
  });

  it("renders empty sections as the fixed empty text and ignores changes without a baseline", () => {
    const rendered = renderDailyReport(
      report({
        daily_work: [],
        resolved_items: [],
        tomorrow_focus: [],
        changes_compared_to_yesterday: ["Invented change."],
      }),
      { ...context, hasYesterdayBaseline: false },
    );
    expect(rendered).toContain("## Daily Work\n\nNone observed.\n");
    expect(rendered).toContain(
      "## Changes Compared To Yesterday\n\nNo yesterday baseline available.\n",
    );
    expect(rendered).not.toContain("Invented change.");
  });

  it.each([
    [{ source_refs: [] }, "requires source_refs"],
    [{ source_refs: ["room_a", "room_a"] }, "duplicate source_refs"],
    [{ source_refs: ["room_x"] }, "unknown source_ref: room_x"],
    [{ pattern: ["Said so [[source:pocket-note]]."] }, "unselected source_ref"],
    [{ pattern: ["Said so [[source:room_a]."] }, "invalid source_ref marker"],
    [
      { pattern: ["See agent_alice/evidence/2026-09-02/sessions/room_a.md"] },
      "must select Session evidence by source_ref",
    ],
    [
      { resolved_items: ["See teamhub://rooms/room_a"] },
      "must select Session evidence by source_ref",
    ],
    [
      { resolved_items: ["See memory://timeline/daily/2026-09-01.md"] },
      "must select Session evidence by source_ref",
    ],
  ] satisfies Array<[Partial<DailyReportOutput>, string]>)(
    "rejects invalid source selection or citation %#",
    (overrides, message) => {
      expect(() => renderDailyReport(report(overrides), context)).toThrow(
        message,
      );
    },
  );

  it("validates the saved answer against the strict schema", () => {
    const schema = dailyReportSchema(["room_a"]);
    expect(schema.properties.source_refs).not.toHaveProperty("uniqueItems");
    expect(
      parseReportOutput(JSON.stringify(report()), schema, "Daily"),
    ).toEqual(report());
    expect(() =>
      parseReportOutput(
        JSON.stringify({ ...report(), content: "# Daily" }),
        schema,
        "Daily",
      ),
    ).toThrow("Daily output does not match its schema");
    const { pattern: _pattern, ...missing } = report();
    expect(() =>
      parseReportOutput(JSON.stringify(missing), schema, "Daily"),
    ).toThrow("pattern");
    expect(() =>
      parseReportOutput(
        JSON.stringify(report({ source_refs: ["room_b"] })),
        schema,
        "Daily",
      ),
    ).toThrow("does not match its schema");
    expect(() => parseReportOutput("{", schema, "Daily")).toThrow(
      "not valid JSON",
    );
  });

  it("counts a rendered Daily as evidence only when an activity section has an item", () => {
    expect(dailyReportHasEvidence(renderDailyReport(report(), context))).toBe(
      true,
    );
    const empty = report({
      daily_work: [],
      resolved_items: [],
      tomorrow_focus: [],
      changes_compared_to_yesterday: ["Only a comparison."],
    });
    expect(dailyReportHasEvidence(renderDailyReport(empty, context))).toBe(
      false,
    );
    expect(
      dailyReportHasEvidence(
        renderDailyReport(
          { ...empty, unresolved_items: ["Waiting on the vendor."] },
          context,
        ),
      ),
    ).toBe(true);
  });

  it("renders non-English items and counts them as evidence", () => {
    // "Project review" and "Confirmed the budget" in Chinese.
    const rendered = renderDailyReport(
      report({
        title: "\u9879\u76ee\u8bc4\u5ba1",
        daily_work: [],
        resolved_items: ["\u786e\u8ba4\u4e86\u9884\u7b97 [[source:room_a]]"],
        tomorrow_focus: [],
      }),
      context,
    );
    expect(rendered).toContain("# \u9879\u76ee\u8bc4\u5ba1\n");
    expect(rendered).toContain(
      `## Resolved Items\n\n- \u786e\u8ba4\u4e86\u9884\u7b97 ${link}\n`,
    );
    expect(dailyReportHasEvidence(rendered)).toBe(true);
  });
});
