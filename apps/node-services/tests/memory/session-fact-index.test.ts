import { describe, expect, it } from "vitest";
import {
  factChunk,
  messageAt,
  sessionFactText,
} from "../../src/memory/session-fact-index.js";

describe("Session fact binding", () => {
  it("takes the mention time and speaker from the enclosing Room message", () => {
    const content = [
      "## 2026-09-29T01:00:00.000Z · Ann",
      "",
      "Morning.",
      "",
      "## 2026-09-29T07:00:00.000Z · Bob",
      "",
      "Max turned three today.",
    ].join("\n");
    expect(messageAt(content, content.indexOf("Max turned"))).toEqual({
      mentionedAt: "2026-09-29T07:00:00.000Z",
      speaker: "Bob",
    });
    expect(
      messageAt("Recording transcript without headings", 5),
    ).toBeUndefined();
  });
});

describe("Session fact chunk", () => {
  it("binds a fact to the window chunk sharing the most terms", () => {
    const chunk = (id: string, content: string) => ({
      id,
      content,
      start: 0,
      end: content.length,
      heading: "",
      headingPath: [],
      lineStart: 1,
      lineEnd: 1,
      level: 2,
    });
    const chunks = [
      chunk("a", "We talked about packing for the trip."),
      chunk("b", "Max the Golden Retriever turned three."),
    ];
    expect(
      factChunk(
        { what: "Max is a Golden Retriever", entities: ["Max"] },
        chunks as never,
      ).id,
    ).toBe("b");
  });
});

describe("Session fact text", () => {
  it("joins what, when, who and why as Hindsight stores them, skipping N/A", () => {
    expect(
      sessionFactText({
        what: "User started cello lessons",
        when: "February 2024",
        where: "Home",
        who: "user",
        why: "N/A",
        fact_type: "world",
      }),
    ).toBe(
      "User started cello lessons | When: February 2024 | Involving: user",
    );
    expect(
      sessionFactText({
        what: "Mia opened a bakery",
        when: "n/a",
        who: "Mia (user's sister)",
        why: "She wanted her own shop",
        fact_type: "world",
      }),
    ).toBe(
      "Mia opened a bakery | Involving: Mia (user's sister) | She wanted her own shop",
    );
  });
});

describe("temporal window coverage", () => {
  it("spreads entry points across the window instead of one busy day", async () => {
    const { selectWithTemporalCoverage } =
      await import("../../src/memory/search/temporal-window.js");
    const busy = Array.from({ length: 20 }, (_, i) => ({
      id: `busy-${i}`,
      date: "2026-04-02",
    }));
    const late = { id: "late", date: "2026-04-28" };
    const selected = selectWithTemporalCoverage(
      [...busy, late],
      (row) => row.date,
      {
        from: "2026-04-01",
        to: "2026-04-30",
      },
    );
    expect(selected).toHaveLength(10);
    expect(selected.map((row) => row.id)).toContain("late");
    // Similarity order (input order) is kept among the selected rows.
    expect(selected.at(-1)!.id).toBe("late");
  });
});
