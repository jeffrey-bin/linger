import { describe, expect, it, vi } from "vitest";
import {
  defaultGuideline,
  dreamProactiveGuideline,
  exchangesFromRows,
  maxClues,
  maxSpecificRules,
  nextGuideline,
  parseDreamPrompt,
  type DreamStore,
  type Guideline,
  type ProactiveExchange,
} from "../../src/memory/proactive-dreaming.js";

const owner = { tenantId: "tenant_acme", ownerActorId: "actor_alice" };

function memoryStore(
  exchanges: ProactiveExchange[],
  guideline: Guideline = defaultGuideline(),
) {
  const saved: { guideline: Guideline; note: string }[] = [];
  const cleared: Date[] = [];
  const store: DreamStore = {
    guideline: async (who) => {
      expect(who).toEqual(owner);
      return guideline;
    },
    exchanges: async (who) => {
      expect(who).toEqual(owner);
      return exchanges;
    },
    save: async (who, next, note) => {
      expect(who).toEqual(owner);
      saved.push({ guideline: next, note });
    },
    clear: async (who, before) => {
      expect(who).toEqual(owner);
      cleared.push(before);
    },
  };
  return { store, saved, cleared };
}

const reminder: ProactiveExchange = {
  source: "review",
  output: "Needs attention: the blocker on project A is cleared",
  at: "2026-10-19T01:10:00.000Z",
  replies: [
    {
      author: "Ming Chen",
      authorKind: "human",
      text: "Tell me directly once this kind of blocker is cleared",
      at: "2026-10-19T01:12:00.000Z",
    },
  ],
};

describe("proactive dreaming", () => {
  it("writes the next guideline version from the day's replies, then clears the day", async () => {
    const { store, saved, cleared } = memoryStore([reminder]);
    const request = vi.fn(async () => ({
      specific: [
        "project A blocker cleared → remind directly",
        "project A blocker cleared → remind directly",
      ],
      removed_rules: [],
      clues: [
        {
          matter: " Zoe's prototype quote ",
          kind: "hardware prototyping",
          time: "",
          leaning: "remind_directly",
          seen: 1,
          last_seen: "2026-10-19",
        },
      ],
      change_note: "user wants a direct reminder when blockers clear",
    }));
    const before = new Date("2026-10-19T16:00:00Z");
    const result = await dreamProactiveGuideline(owner, store, {
      before,
      request,
    });
    expect(result).toEqual({ status: "updated", version: 2, exchanges: 1 });
    expect(saved).toEqual([
      {
        guideline: {
          version: 2,
          specific: ["project A blocker cleared → remind directly"],
          clues: [
            {
              matter: "Zoe's prototype quote",
              kind: "hardware prototyping",
              time: null,
              leaning: "remind_directly",
              seen: 1,
              last_seen: "2026-10-19",
            },
          ],
        },
        note: "user wants a direct reminder when blockers clear",
      },
    ]);
    expect(cleared).toEqual([before]);
    const prompt = JSON.parse(
      (request.mock.calls[0] as unknown as [{ user: string }])[0].user,
    );
    expect(prompt.today).toBe("2026-10-19");
    expect(prompt.clues).toEqual([]);
    expect(prompt.exchanges[0].at).toBe("09:10");
    expect(prompt.exchanges[0].followed_by[0]).toEqual({
      speaker: "user",
      at: "09:12",
      text: "Tell me directly once this kind of blocker is cleared",
    });
  });

  it("learns concrete follow-up preferences using tracking rather than the retired list", async () => {
    const { store, saved } = memoryStore([reminder]);
    const request = vi.fn(async () => ({
      specific: ["client contracts → track for follow-up"],
      removed_rules: [],
      clues: [
        {
          matter: "client reply",
          kind: "client communication",
          time: null,
          leaning: "track_for_follow_up",
          seen: 1,
          last_seen: "2026-10-19",
        },
      ],
      change_note: "client reply needs follow-up",
    }));
    await dreamProactiveGuideline(owner, store, { request });
    expect(saved[0]?.guideline).toMatchObject({
      specific: ["client contracts → track for follow-up"],
      clues: [{ leaning: "track_for_follow_up" }],
    });
    const input = request.mock.calls[0] as unknown as [
      {
        system: string;
        schema: {
          properties: {
            clues: { items: { properties: { leaning: { enum: string[] } } } };
          };
        };
      },
    ];
    expect(
      input[0].schema.properties.clues.items.properties.leaning.enum,
    ).toEqual(["remind_directly", "track_for_follow_up", "stay_silent"]);
    expect(input[0].system).toContain("track for follow-up");
    expect(input[0].system).not.toContain("put on the list");
  });

  it("only empties the day when nothing was shown", async () => {
    const request = vi.fn();
    const before = new Date("2026-10-20T00:05:00+08:00");
    const empty = memoryStore([]);
    expect(
      await dreamProactiveGuideline(owner, empty.store, { before, request }),
    ).toEqual({ status: "no_exchanges" });
    expect(request).not.toHaveBeenCalled();
    expect(empty.saved).toEqual([]);
    expect(empty.cleared).toEqual([before]);
  });

  it("keeps the day when the model fails, so the next night learns it again", async () => {
    const { store, saved, cleared } = memoryStore([reminder]);
    const request = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    await expect(
      dreamProactiveGuideline(owner, store, { request }),
    ).rejects.toThrow("gateway");
    expect(saved).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("bounds the rules", () => {
    const rules = Array.from({ length: 30 }, (_, index) => `rule ${index}`);
    const next = nextGuideline(
      { version: 3, specific: [], clues: [] },
      { specific: rules, removed_rules: [], clues: [], change_note: "" },
      "2026-10-19",
    );
    expect(next.version).toBe(4);
    expect(next.specific).toHaveLength(maxSpecificRules);
  });

  it("drops a rule only when the answer names it as removed", () => {
    const current = {
      ...defaultGuideline(),
      specific: [
        "guitar → remind directly",
        "marketing email → stay silent",
        "NAS shopping → stay silent",
      ],
    };
    const next = nextGuideline(
      current,
      {
        specific: ["home storage → stay silent"],
        removed_rules: ["NAS shopping → stay silent"],
        clues: [],
        change_note: "",
      },
      "2026-10-24",
    );
    expect(next.specific).toEqual([
      "home storage → stay silent",
      "guitar → remind directly",
      "marketing email → stay silent",
    ]);
  });

  it("keeps one recent clue per matter and drops stale ones", () => {
    const clue = (matter: string, last_seen: string, seen = 1) => ({
      matter,
      kind: "hardware prototyping",
      time: null,
      leaning: "remind_directly" as const,
      seen,
      last_seen,
    });
    const many = Array.from({ length: 25 }, (_, index) =>
      clue(
        `item ${index}`,
        `2026-10-${String(10 + (index % 10)).padStart(2, "0")}`,
      ),
    );
    const { clues } = nextGuideline(
      defaultGuideline(),
      {
        specific: [],
        removed_rules: [],
        clues: [
          clue("prototype quote", "2026-10-01"),
          clue("CNC lead time", "2026-10-18"),
          clue("CNC lead time", "2026-10-19", 2),
          clue("future item", "2026-12-01"),
          ...many,
        ],
        change_note: "",
      },
      "2026-10-19",
    );
    expect(clues).toHaveLength(maxClues);
    expect(
      clues.find((kept) => kept.matter === "prototype quote"),
    ).toBeUndefined();
    expect(clues.filter((kept) => kept.matter === "CNC lead time")).toEqual([
      clue("CNC lead time", "2026-10-19", 2),
    ]);
    expect(clues.find((kept) => kept.matter === "future item")?.last_seen).toBe(
      "2026-10-19",
    );
  });

  it("groups each output with the Messages that followed it", () => {
    const exchanges = exchangesFromRows([
      {
        message_id: "m1",
        source: "review",
        output_body: "Reminder: meeting",
        output_at: new Date("2026-10-19T01:00:00Z"),
        position: 1,
        author: "Ming Chen",
        author_kind: "human",
        body: "No need to remind me",
        at: new Date("2026-10-19T01:01:00Z"),
      },
      {
        message_id: "m1",
        source: "review",
        output_body: "Reminder: meeting",
        output_at: new Date("2026-10-19T01:00:00Z"),
        position: 2,
        author: "AnotherMe",
        author_kind: "agent",
        body: "OK",
        at: new Date("2026-10-19T01:02:00Z"),
      },
      {
        message_id: "m2",
        source: "review",
        output_body: "Reminder",
        output_at: new Date("2026-10-19T02:00:00Z"),
        position: 0,
        author: "",
        author_kind: "",
        body: "",
        at: null,
      },
    ]);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({ source: "review" });
    expect(exchanges[0]!.replies).toHaveLength(2);
    expect(exchanges[1]!.replies).toEqual([]);
  });

  it("reads the system prompt and general rules from the prompt file", () => {
    const fence = "```";
    const prompt = parseDreamPrompt(
      [
        "# Title",
        "## General rules",
        "Context.",
        "- Rule one.",
        "- Rule two.",
        "## System prompt",
        `${fence}text`,
        "Keep at most {{maxSpecificRules}} rules and {{maxClues}} clues.",
        "- a line that looks like a list item",
        fence,
      ].join("\n"),
    );
    expect(prompt).toEqual({
      generalRules: ["Rule one.", "Rule two."],
      system: `Keep at most ${maxSpecificRules} rules and ${maxClues} clues.\n- a line that looks like a list item`,
    });
    expect(() => parseDreamPrompt("## General rules\n- Rule.\n")).toThrow(
      "missing a section",
    );
  });
});
