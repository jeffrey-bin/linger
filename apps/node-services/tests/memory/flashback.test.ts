import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  dailyCard,
  dailyReport,
  experienceCard,
  type DailyReport,
} from "../../src/memory/flashback/card.js";
import { FlashbackService } from "../../src/memory/flashback/service.js";
import {
  DEFAULT_FLASHBACK_SETTINGS,
  suggestFlashback,
  type FlashbackRecord,
} from "../../src/memory/flashback/suggest.js";
import type { StoredWikiGraph } from "../../src/memory/graph/build.js";
import { entityNamePatterns } from "../../src/memory/graph/inferred-edges.js";
import { pairTies } from "../../src/memory/graph/pair-strength.js";
import { wikiGraph, wikiNode } from "./wiki-graph-fixture.js";

const sessionBody = (title: string, extra = "") => `# ${title}

## Objective Summary

The team reviewed the Example Client pilot scope and agreed on a small trial. [R1]

## Decisions And Outcomes

- Decision: Start with a three sample documents.
  - Owner: Casey Example
- Decision: Score results with Example Client's own criteria.
- Completed: Trial access was enabled for [Example Client](../../clients/example-client.md).

## Action Items

- Action: Send API documentation.
  - Priority: medium
- Action: Collect feedback on missing dimensions.
  - Priority: high
${extra}`;

const supplierBody = `# Document format review

## Objective Summary

Evaluated document export quality before committing to a pilot. [R1]

## Action Items

- Action: Ask the supplier for a formal quotation.
  - Priority: high
`;

/**
 * Example Client is the topic: meeting a is about it. Meeting c is a
 * different matter (an audio supplier review) reached through the Pilot
 * project; meeting b only touches Example Client in passing.
 */
const graph = (): StoredWikiGraph => ({
  ...wikiGraph(
    [
      wikiNode("clients/example-client", { title: "Example Client" }),
      wikiNode("projects/pilot", { title: "Partner Pilots" }),
      wikiNode("sessions/2026-09-01/capture_session_a", {
        title: "Example Client kickoff",
        body: sessionBody("Example Client kickoff"),
      }),
      wikiNode("sessions/2026-09-10/capture_session_c", {
        title: "Document format review",
        body: supplierBody,
      }),
      wikiNode("sessions/2026-09-10/index", { title: "2026-09-10" }),
      wikiNode("sessions/2026-09-20/capture_session_b", {
        title: "Weekly planning",
        body: "# Weekly planning\n\n## Objective Summary\n\nPlanned the week; Example Client came up once.",
      }),
    ],
    [
      {
        source: "sessions/2026-09-01/capture_session_a",
        target: "clients/example-client",
      },
      { source: "sessions/2026-09-10/index", target: "projects/pilot" },
    ],
  ),
  wikiRevision: "wiki-r1",
  inferredEdges: [
    edge("projects/pilot", "clients/example-client", 0.8),
    edge("sessions/2026-09-10/capture_session_c", "projects/pilot", 0.85),
    edge(
      "sessions/2026-09-20/capture_session_b",
      "clients/example-client",
      0.3,
    ),
  ],
});

function edge(source: string, target: string, weight: number) {
  return { source, target, kind: "mention" as const, weight, count: 1 };
}

const supplierDaily = `---
type: Daily Memory
title: Supplier follow-ups
date: 2026-09-15
---

# Supplier follow-ups

## Daily Work

- **Supplier quotes**: The audio supplier sent its quotation for Partner Pilots [Supplier chat](teamhub://rooms/room_s/messages).

## Resolved Items

- Example Client approved the pilot budget [Planning chat](teamhub://rooms/room_p/messages).
- The supplier fixed the export bug for Partner Pilots.

## Unresolved Items

- Partner Pilots still needs a signed trial agreement [Supplier chat](teamhub://rooms/room_s/messages).

## Tomorrow Focus

- Suggested focus: Chase the Partner Pilots legal review.

## Changes Compared To Yesterday

- Partner Pilots moved from scoping to quotes.

## Sources

- [Supplier chat](teamhub://rooms/room_s/messages)
`;

const dailies = (): DailyReport[] => [
  dailyReport(
    {
      date: "2026-09-15",
      title: "Supplier follow-ups",
      content: supplierDaily,
    },
    entityNamePatterns(graph().nodes),
  ),
];

const now = new Date("2026-10-06T08:00:00Z");
const suggest = (
  text: string,
  history: FlashbackRecord[] = [],
  roomId = "room_now",
) =>
  suggestFlashback({
    graph: graph(),
    aliases: new Map(),
    dailies: dailies(),
    text,
    roomId,
    now,
    history,
  });
const meetingC = "sessions/2026-09-10/capture_session_c";
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

describe("experience card", () => {
  it("reads the situation, decisions, results, and open actions of a Session", () => {
    expect(experienceCard(sessionBody("Kickoff"))).toEqual({
      situation:
        "The team reviewed the Example Client pilot scope and agreed on a small trial.",
      decisions: [
        "Start with a three sample documents.",
        "Score results with Example Client's own criteria.",
      ],
      completed: ["Trial access was enabled for Example Client."],
      // High-priority actions come first.
      openItems: [
        "Collect feedback on missing dimensions.",
        "Send API documentation.",
      ],
    });
  });

  it("separates decisions from completed work in the compact Session schema", () => {
    const body = `# Review

## Objective Summary

Reviewed a conditional pilot.

## Decisions And Outcomes

- Decision: Start the pilot only after access is enabled. [R1]
  - Evidence: Reviewer, 00:20.
- Completed: The API reference was delivered. [R1]
  - Evidence: Reviewer, 00:21.

## Action Items

- Action: Enable access before the pilot. [R1]

## Pattern

None observed.
`;
    expect(experienceCard(body)).toEqual({
      situation: "Reviewed a conditional pilot.",
      decisions: ["Start the pilot only after access is enabled."],
      completed: ["The API reference was delivered."],
      openItems: ["Enable access before the pilot."],
    });
    expect(
      experienceCard(body.replace(/- Completed:.*\n/u, "")).completed,
    ).toEqual([]);
  });

  it("leaves missing sections empty", () => {
    expect(experienceCard("# Notes\n\nJust a short note.")).toEqual({
      situation: "Just a short note.",
      decisions: [],
      completed: [],
      openItems: [],
    });
  });
});

describe("Daily items", () => {
  it("reads the activity items with the entities they name and the Rooms they cite", () => {
    const [report] = dailies();
    expect(report!.items).toEqual([
      {
        kind: "work",
        text: "Supplier quotes: The audio supplier sent its quotation for Partner Pilots.",
        rooms: ["room_s"],
        entities: ["projects/pilot"],
      },
      {
        kind: "resolved",
        text: "Example Client approved the pilot budget.",
        rooms: ["room_p"],
        entities: ["clients/example-client"],
      },
      {
        kind: "resolved",
        text: "The supplier fixed the export bug for Partner Pilots.",
        rooms: [],
        entities: ["projects/pilot"],
      },
      {
        kind: "unresolved",
        text: "Partner Pilots still needs a signed trial agreement.",
        rooms: ["room_s"],
        entities: ["projects/pilot"],
      },
    ]);
  });

  it("makes a card of a day's items about one thing", () => {
    const [report] = dailies();
    expect(
      dailyCard(
        report!.items.filter((item) =>
          item.entities.includes("projects/pilot"),
        ),
      ),
    ).toEqual({
      situation:
        "Supplier quotes: The audio supplier sent its quotation for Partner Pilots.",
      decisions: [],
      completed: ["The supplier fixed the export bug for Partner Pilots."],
      openItems: ["Partner Pilots still needs a signed trial agreement."],
    });
  });
});

describe("pair ties", () => {
  it("takes the strongest evidence for a pair", () => {
    const ties = pairTies(graph());
    expect(
      ties
        .get("clients/example-client")
        ?.get("sessions/2026-09-01/capture_session_a"),
    ).toMatchObject({ strength: 0.5, kinds: ["link"] });
    expect(
      ties.get("projects/pilot")?.get("clients/example-client"),
    ).toMatchObject({ strength: 0.8, kinds: ["mention"] });
  });
});

describe("flashback suggestion", () => {
  it("recalls a different meeting through a bridge, never the topic itself", () => {
    const result = suggest("How is the Example Client trial going?");
    expect(result.reason).toBe("suggested");
    expect(result.suggestion).toMatchObject({
      episode: meetingC,
      title: "Document format review",
      date: "2026-09-10",
      cue: {
        id: "clients/example-client",
        title: "Example Client",
        via: "name",
      },
      bridge: { id: "projects/pilot", title: "Partner Pilots" },
      ties: ["mention"],
      openItems: ["Ask the supplier for a formal quotation."],
    });
  });

  it("recalls a day's Daily items through a bridge, without the items about the cue", () => {
    const result = suggest("Example Client", [
      { episode: meetingC, at: daysAgo(1) },
    ]);
    expect(result.reason).toBe("suggested");
    expect(result.suggestion).toMatchObject({
      episode: "daily/2026-09-15",
      title: "Supplier follow-ups",
      date: "2026-09-15",
      bridge: { id: "projects/pilot", title: "Partner Pilots" },
      ties: ["mention"],
      completed: ["The supplier fixed the export bug for Partner Pilots."],
      openItems: ["Partner Pilots still needs a signed trial agreement."],
    });
  });

  it("falls back to a meeting that only touched the cue in passing", () => {
    const passing = suggest("Example Client", [
      { episode: meetingC, at: daysAgo(1) },
      { episode: "daily/2026-09-15", at: daysAgo(2) },
    ]);
    expect(passing.suggestion).toMatchObject({
      episode: "sessions/2026-09-20/capture_session_b",
    });
    expect(passing.suggestion?.bridge).toBeUndefined();
  });

  it("needs a cue and never recalls Daily items from the Room being talked in", () => {
    expect(suggest("Let's plan next week").reason).toBe("no_cue");
    const inSupplierRoom = suggest(
      "Example Client",
      [{ episode: meetingC, at: daysAgo(1) }],
      "room_s",
    );
    expect(inSupplierRoom.suggestion).toMatchObject({
      episode: "daily/2026-09-15",
      situation: "",
      completed: ["The supplier fixed the export bug for Partner Pilots."],
      openItems: [],
    });
  });

  it("does not call a recent meeting a flashback", () => {
    const fresh = suggestFlashback({
      graph: graph(),
      aliases: new Map(),
      dailies: [],
      text: "Example Client",
      roomId: "room_now",
      now: new Date("2026-09-11T00:00:00Z"),
      history: [],
    });
    expect(fresh.reason).toBe("below_threshold");
  });

  it("does not recall through a cue that just led to a flashback", () => {
    const at = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    expect(
      suggest("Example Client", [
        {
          episode: "daily/2026-09-01",
          cue: "clients/example-client",
          roomId: "room_y",
          at,
        },
      ]).reason,
    ).toBe("no_cue");
  });

  it("keeps to the Room cooldown, the daily limit, and episode repeats", () => {
    const at = (minutesAgo: number) =>
      new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    expect(
      suggest("Example Client", [
        { episode: "daily/2026-09-01", roomId: "room_now", at: at(10) },
      ]).reason,
    ).toBe("room_cooldown");
    expect(
      suggest(
        "Example Client",
        Array.from({ length: DEFAULT_FLASHBACK_SETTINGS.dailyLimit }, () => ({
          episode: "daily/2026-09-01",
          at: at(120),
        })),
      ).reason,
    ).toBe("daily_limit");
    expect(
      suggest("Example Client", [{ episode: meetingC, at: at(60 * 24 * 2) }])
        .suggestion?.episode,
    ).toBe("daily/2026-09-15");
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((value) => fs.rm(value, { recursive: true, force: true })),
  );
});

describe("flashback service", () => {
  it("counts only recorded flashbacks against the budgets", async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "flashback-"));
    roots.push(data);
    let reads = 0;
    let dailyRevision = "daily-r1";
    const service = new FlashbackService(data, {
      readRevision: async (tenantId) =>
        tenantId === "tenant_1" ? "wiki-r1" : undefined,
      readWiki: async () => {
        reads += 1;
        return { revision: "wiki-r1", pages: wikiPages() };
      },
      readDailyRevision: async () => dailyRevision,
      readDailies: async () => ({
        revision: dailyRevision,
        reports: [
          {
            date: "2026-09-15",
            title: "Supplier follow-ups",
            content: supplierDaily,
          },
        ],
      }),
      loadSubjects: async () => [
        {
          tenantId: "tenant_1",
          agentManagementId: "agent_1",
          memorySubjectKey: "agent_1",
          representedHumanActorId: "human_1",
        },
      ],
      now: () => now,
    });
    const request = {
      tenant_id: "tenant_1",
      owner_actor_id: "human_1",
      room_id: "room_now",
      text: "Any news from Example Client?",
    };
    const first = await service.suggest(request);
    expect(first).toMatchObject({
      reason: "suggested",
      suggestion: { episode: meetingC, wikiRevision: "wiki-r1" },
    });
    // A suggestion the Agent did not use costs nothing.
    await expect(service.suggest(request)).resolves.toMatchObject({
      reason: "suggested",
    });
    await service.record({
      tenant_id: "tenant_1",
      owner_actor_id: "human_1",
      room_id: "room_now",
      episode: first.suggestion!.episode,
      cue_id: first.suggestion!.cue.id,
    });
    await expect(service.suggest(request)).resolves.toEqual({
      reason: "room_cooldown",
    });
    await expect(
      service.suggest({ ...request, tenant_id: "tenant_2" }),
    ).resolves.toEqual({ reason: "no_graph" });
    // The graph is built once per indexed Wiki and Daily revision.
    expect(reads).toBe(1);
    dailyRevision = "daily-r2";
    await service.suggest({ ...request, room_id: "room_other" });
    expect(reads).toBe(2);
  });
});

/** The published pages behind the scenario of `graph()`. */
function wikiPages() {
  const page = (key: string, content: string) => ({
    key,
    title: key,
    content,
    metadata: {},
  });
  return [
    page("clients/example-client.md", "# Example Client\n"),
    page(
      "projects/pilot.md",
      "# Partner Pilots\n\n## Project Summary\n\nPilots we run with [Example Client](../clients/example-client.md). Example Client sponsors them.\n",
    ),
    page(
      "sessions/2026-09-01/capture_session_a.md",
      sessionBody("Example Client kickoff"),
    ),
    page(
      `${meetingC}.md`,
      `${supplierBody}\n## Decisions And Outcomes\n\n- Decision: Run the review under [Partner Pilots](../../projects/pilot.md).\n`,
    ),
    page(
      "sessions/2026-09-20/capture_session_b.md",
      "# Weekly planning\n\n## Objective Summary\n\nPlanned the week; Example Client came up once.",
    ),
  ];
}
