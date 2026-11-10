import { expect, it } from "vitest";
import { formatReportDay, parseDailyReport } from "./wiki-daily-card";

it("reads a generated Daily Memory as the design's short card", () => {
  const parts = parseDailyReport({
    summary: "Supplier capability review：a long body.",
    content: [
      "---",
      "type: Daily Memory",
      "description: Notes on audio and AI hardware supplier talks and follow-ups.",
      "sources:",
      "  - title: 2026-09-09 Audio and AI hardware partner talk",
      "    resource: evidence/2026-09-09/sessions/room.md",
      "---",
      "",
      "## Daily Work",
      "- **Supplier capability review**: Zhang Bo’s side explained the needs.[2026-09-09 Audio and AI hardware partner talk](evidence/room.md)",
      "- **Youdao AI earbud demo**: the earbuds were shown live.",
      "- **Recorder clip tech plan**: the third bullet stays off the card.",
      "",
      "## Tomorrow Focus",
      "- Suggested focus: Re-evaluate with the new ID.",
      "",
      "## Sources",
      "- [2026-09-09 Audio and AI hardware partner talk](teamhub://rooms/r1)",
      "- [2026-09-09 Supplier follow-up](teamhub://rooms/r2)",
      "",
    ].join("\n"),
  });
  expect(parts).toEqual({
    summary: "Notes on audio and AI hardware supplier talks and follow-ups.",
    highlights: ["Supplier capability review", "Youdao AI earbud demo"],
    next: "Re-evaluate with the new ID.",
  });
  expect(formatReportDay("2026-10-29")).toBe("Thu, Oct 29");
});

it("keeps plain bullets whole and falls back to the entry summary", () => {
  expect(
    parseDailyReport({
      summary: "Prepared the launch checklist.",
      content:
        "## Daily Work\n\n- Finalized the **release** scope [[source:s1]].\n\n## Tomorrow Focus\n\n- Ship the first release.\n",
    }),
  ).toEqual({
    summary: "Prepared the launch checklist.",
    highlights: ["Finalized the release scope."],
    next: "Ship the first release.",
  });
});

it("skips None observed sections and keeps an unbolded lead whole", () => {
  expect(
    parseDailyReport({
      summary: "",
      content: [
        "## Daily Work",
        "",
        "None observed.",
        "",
        "## Resolved Items",
        "",
        "- Closed the vendor contract: signed today.",
        "",
        "## Tomorrow Focus",
        "",
        "None observed.",
        "",
        "## Source Sessions",
        "",
        "- [2026-09-09 Old heading](teamhub://rooms/r1)",
      ].join("\n"),
    }),
  ).toEqual({
    summary: "Closed the vendor contract: signed today.",
    highlights: ["Closed the vendor contract: signed today."],
    next: "",
  });
});
