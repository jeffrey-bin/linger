import { describe, expect, it } from "vitest";

import { parseReportOutput } from "../../src/memory/report-render.js";
import {
  renderWeeklyReport,
  weeklyReportSchema,
  type WeeklyReportOutput,
} from "../../src/memory/weekly-report.js";

const catalog = [
  {
    sourceRef: "daily_2026-10-13",
    resource: "memory://timeline/daily/2026-10-13.md",
    title: "Daily 2026-10-13",
  },
  {
    sourceRef: "previous_week_2026-10-05",
    resource: "memory://timeline/weekly/2026-10-05.md",
    title: "Previous Weekly baseline 2026-10-05",
  },
];
const context = {
  weekStart: "2026-10-12",
  memorySubjectKey: "agent_alice",
  hasPreviousWeekly: true,
  catalog,
  now: new Date("2026-10-19T00:00:00.000Z"),
};

function report(
  overrides: Partial<WeeklyReportOutput> = {},
): WeeklyReportOutput {
  return {
    description: "Shipped the draft.",
    source_refs: ["daily_2026-10-13", "previous_week_2026-10-05"],
    closed_works: ["Draft completed [[source:daily_2026-10-13]]."],
    ongoing_works: [],
    open_works: [],
    big_change: ["Moved from planning to delivery."],
    work_intensity: "One active day\nwith a review.",
    pattern: [],
    ...overrides,
  };
}

describe("Weekly report rendering", () => {
  it("renders the whole Weekly file from the model's fields", () => {
    expect(renderWeeklyReport(report(), context)).toBe(`---
type: Weekly User Dynamic Memory
title: "User Dynamic: 2026-10-12"
description: Shipped the draft.
week_start: 2026-10-12
memory_subject_key: agent_alice
status: stable
generated:
  by: linger-memory/1
  at: 2026-10-19T00:00:00.000Z
sources:
  - title: Daily 2026-10-13
    resource: memory://timeline/daily/2026-10-13.md
  - title: Previous Weekly baseline 2026-10-05
    resource: memory://timeline/weekly/2026-10-05.md
---

# User Dynamic: 2026-10-12

## Closed Works

- Draft completed [Daily 2026-10-13](../daily/2026-10-13.md).

## Ongoing Works

None observed.

## Open Works

None observed.

## Big Change

- Moved from planning to delivery.

## Work Intensity

One active day with a review.

## Pattern

None observed.

## Sources

- [Daily 2026-10-13](../daily/2026-10-13.md)
- [Previous Weekly baseline 2026-10-05](../weekly/2026-10-05.md)
`);
  });

  it("ignores Big Change without a previous Weekly", () => {
    const rendered = renderWeeklyReport(report(), {
      ...context,
      hasPreviousWeekly: false,
    });
    expect(rendered).toContain(
      "## Big Change\n\nNo previous dynamic profile available.\n",
    );
    expect(rendered).not.toContain("Moved from planning");
  });

  it("rejects an invented source link", () => {
    expect(() =>
      renderWeeklyReport(
        report({
          closed_works: ["[2026-10-14](memory://timeline/daily/2026-10-13.md)"],
        }),
        context,
      ),
    ).toThrow("source_ref");
  });

  it("validates the saved answer against the strict schema", () => {
    const schema = weeklyReportSchema(catalog.map((s) => s.sourceRef));
    expect(
      parseReportOutput(JSON.stringify(report()), schema, "Weekly"),
    ).toEqual(report());
    expect(() =>
      parseReportOutput(
        JSON.stringify({ ...report(), title: "Mine" }),
        schema,
        "Weekly",
      ),
    ).toThrow("Weekly output does not match its schema");
    expect(() =>
      parseReportOutput(
        JSON.stringify(report({ work_intensity: " " })),
        schema,
        "Weekly",
      ),
    ).toThrow("does not match its schema");
  });
});
