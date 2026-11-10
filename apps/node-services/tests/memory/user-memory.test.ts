import { describe, it, expect, vi } from "vitest";
import {
  applyUserMemoryEdits,
  emptyUserMemory,
  initialUserMemory,
  maintainUserMemory,
  quotedIn,
  renderUserMemory,
  updateUserMemory,
  USER_MEMORY_CAPACITY,
  USER_MEMORY_SECTION_LIMITS,
  USER_MEMORY_SECTIONS,
  userMemoryBytes,
  UserMemoryConflictError,
  type UserMemoryEdit,
  type UserMemoryEvidence,
  type UserMemoryRevision,
  type UserMemorySections,
  type UserMemoryStore,
} from "../../src/memory/user-memory.js";
import {
  dailyEvidenceParts,
  profileEvidence,
} from "../../src/memory/user-memory-sync.js";
import type { requestMemoryStructuredOutput } from "../../src/memory/llm.js";
import { ModelCallError } from "../../src/runtime-model-call.js";
import { modelCallPolicies } from "../../src/model-tasks.js";

const owner = { tenantId: "tenant_a", ownerActorId: "human_a" };
const memory = (): UserMemorySections => ({
  ...emptyUserMemory(),
  profile: [{ text: "Leads product at Acme", date: "2026-10-01" }],
  career: [
    { text: "Shipping ticket routing; blocked on review", date: "2026-10-20" },
  ],
});
const session: UserMemoryEvidence = {
  ref: "S1",
  kind: "session",
  content: "## 2026-11-03T09:00:00Z · Alice\nต่อไปรายงานข้อมูล ใช้ตารางเสมอ\n",
};
const daily: UserMemoryEvidence = {
  ref: "daily",
  kind: "daily",
  content: "Ticket routing passed review.",
};
const edit = (e: Partial<UserMemoryEdit>): UserMemoryEdit => ({
  op: "add",
  section: "communication_and_working_style",
  old: "",
  text: "",
  source_ref: "daily",
  quote: "",
  ...e,
});

describe("applyUserMemoryEdits", () => {
  it("adds, replaces and deletes with the run date and keeps other entries", () => {
    const current = memory();
    const { sections: next } = applyUserMemoryEdits(
      current,
      [
        edit({
          text: "Prefers tables for data-heavy replies",
          source_ref: "S1",
          quote: "ต่อไปรายงานข้อมูลใช้ตารางเสมอ",
        }),
        edit({
          op: "replace",
          section: "career",
          old: "Shipping ticket routing; blocked on review",
          text: "Ticket routing launch scheduled for 2026-11-28",
        }),
      ],
      "2026-11-03",
      [session, daily],
    );
    expect(next.profile).toEqual(current.profile);
    expect(next.communication_and_working_style).toEqual([
      { text: "Prefers tables for data-heavy replies", date: "2026-11-03" },
    ]);
    expect(next.career).toEqual([
      {
        text: "Ticket routing launch scheduled for 2026-11-28",
        date: "2026-11-03",
      },
    ]);
    expect(current.career[0]!.date).toBe("2026-10-20");
    const { sections: removed } = applyUserMemoryEdits(
      next,
      [
        edit({
          op: "delete",
          section: "profile",
          old: "Leads product at Acme",
          source_ref: "memory",
        }),
      ],
      "2026-11-04",
      [],
    );
    expect(removed.profile).toEqual([]);
    expect(renderUserMemory(removed)).toContain(
      "- Prefers tables for data-heavy replies [2026-11-03]",
    );
  });

  it("finds an entry the model placed in the wrong section and moves it", () => {
    const { sections: next } = applyUserMemoryEdits(
      memory(),
      [
        edit({
          op: "replace",
          section: "milestones",
          old: "Shipping ticket routing; blocked on review",
          text: "2026-11-28 Launched ticket routing",
        }),
      ],
      "2026-11-28",
      [daily],
    );
    expect(next.career).toEqual([]);
    expect(next.milestones).toEqual([
      { text: "2026-11-28 Launched ticket routing", date: "2026-11-28" },
    ]);
  });

  it.each([
    [
      edit({ op: "replace", section: "profile", old: "Leads", text: "x" }),
      "matches no entry",
    ],
    [edit({ text: "x", source_ref: "S9" }), "unknown source_ref"],
    [edit({ text: "Prefers tables [2026-11-03]" }), "bracketed date"],
    [edit({ text: "two\nlines" }), "one line"],
    [
      edit({ section: "milestones", text: "Got promoted recently" }),
      "event date",
    ],
    [
      edit({ section: "profile", text: "Leads product at Acme" }),
      "already exists",
    ],
    [edit({ text: "x".repeat(201) }), "one line"],
    [edit({ text: "かんけつなレポートとソースリンクをこのむ" }), "in English"],
  ])("rejects %j", (bad, message) => {
    expect(() =>
      applyUserMemoryEdits(memory(), [bad], "2026-11-03", [session, daily]),
    ).toThrow(message);
  });

  it("seeds only a meaningful display name, independently of the model", () => {
    expect(
      initialUserMemory("Nora Ansel", "actor_1", "2026-01-01").profile,
    ).toEqual([{ text: "Nora Ansel", date: "2026-01-01" }]);
    for (const label of ["", "user", "actor_1"])
      expect(initialUserMemory(label, "actor_1", "2026-01-01").profile).toEqual(
        [],
      );
  });

  it("always renders the five portrait sections, including empty preferences", () => {
    const markdown = renderUserMemory(emptyUserMemory());
    expect(
      markdown.split("\n").filter((line) => line.startsWith("## ")),
    ).toEqual([
      "## Profile",
      "## Career",
      "## Interests",
      "## Communication & Working Style",
      "## Milestones",
    ]);
    expect(markdown).toContain(
      "## Communication & Working Style\nNone recorded.",
    );
  });

  it("merges two stages of one milestone without losing either date or touching other events", () => {
    const applied = "2023-08 Applied to adopt";
    const passed = "2023-10-20 Passed adoption agency interviews";
    const reading = "2023-10-06 Attended a poetry reading";
    const current = {
      ...emptyUserMemory(),
      milestones: [applied, reading, passed].map((text) => ({
        text,
        date: "2023-10-22",
      })),
    };
    const merged =
      "2023-10-20 Passed adoption agency interviews after applying in 2023-08";
    const merge = edit({
      op: "replace",
      section: "milestones",
      old: [applied, passed],
      text: merged,
      source_ref: "memory",
    });
    const apply = (e: UserMemoryEdit) =>
      applyUserMemoryEdits(current, [e], "2023-10-29", [], true).sections
        .milestones;
    expect(apply(merge)).toEqual([
      current.milestones[1],
      { text: merged, date: "2023-10-29" },
    ]);
    expect(apply({ ...merge, old: [applied, "missing"] })).toEqual(
      current.milestones,
    );
    expect(apply({ ...merge, text: "x".repeat(201) })).toEqual(
      current.milestones,
    );
  });

  it("drops only the edits whose quote is not the Human's words", () => {
    const { sections, applied } = applyUserMemoryEdits(
      memory(),
      [
        edit({
          text: "Always tables",
          source_ref: "S1",
          quote: "always tables",
        }),
        edit({ text: "No quote", source_ref: "S1", quote: "" }),
        edit({
          text: "Prefers tables",
          source_ref: "S1",
          quote: "“ต่อไปรายงานข้อมูล… ใช้ตารางเสมอ”",
        }),
        edit({ text: "Prefers short replies" }),
      ],
      "2026-11-03",
      [session, daily],
    );
    expect(applied.map((e) => e.text)).toEqual([
      "Prefers tables",
      "Prefers short replies",
    ]);
    expect(sections.communication_and_working_style.map((e) => e.text)).toEqual(
      ["Prefers tables", "Prefers short replies"],
    );
  });

  it.each([
    ["Likes TEA, a lot!", "Alice: likes tea a lot", true],
    ["likes tea ... chess", "Alice: likes tea and plays chess", true],
    ["chess ... likes tea", "Alice: likes tea and plays chess", false],
    ["ok", "ok", false],
  ])("matches quote %j in %j: %s", (quote, content, found) => {
    expect(quotedIn(quote, content)).toBe(found);
  });

  it("rejects a result over the byte limit", () => {
    const edits = USER_MEMORY_SECTIONS.flatMap(({ key }) =>
      Array.from({ length: USER_MEMORY_SECTION_LIMITS[key] }, (_, i) =>
        edit({ section: key, text: `2026-01 ${i} ${"y".repeat(188)}` }),
      ),
    );
    expect(() =>
      applyUserMemoryEdits(emptyUserMemory(), edits, "2026-11-03", [daily]),
    ).toThrow(`over ${USER_MEMORY_CAPACITY.max_bytes}`);
  });

  it("keeps the most recent milestones when a new one arrives", () => {
    const full = {
      ...emptyUserMemory(),
      milestones: Array.from(
        { length: USER_MEMORY_SECTION_LIMITS.milestones },
        (_, i) => ({
          text: `2026-0${i + 1}-01 Event ${i}`,
          date: "2026-10-01",
        }),
      ),
    };
    const { sections } = applyUserMemoryEdits(
      full,
      [edit({ section: "milestones", text: "2026-10-20 Launched v2" })],
      "2026-11-03",
      [daily],
    );
    expect(sections.milestones).toHaveLength(
      USER_MEMORY_SECTION_LIMITS.milestones,
    );
    expect(sections.milestones.map((e) => e.text)).not.toContain(
      "2026-01-01 Event 0",
    );
    expect(sections.milestones.at(-1)?.text).toBe("2026-10-20 Launched v2");
  });

  it("rejects a section growing past its limit, but lets one over it shrink", () => {
    const full = {
      ...emptyUserMemory(),
      career: Array.from(
        { length: USER_MEMORY_SECTION_LIMITS.career },
        (_, i) => ({ text: `Effort ${i}`, date: "2026-10-01" }),
      ),
    };
    const add = edit({ section: "career", text: "Effort new" });
    expect(() =>
      applyUserMemoryEdits(full, [add], "2026-11-03", [daily]),
    ).toThrow("at most 5");
    const other = edit({ section: "interests", text: "Plays chess" });
    const salvage = applyUserMemoryEdits(
      full,
      [add, other],
      "2026-11-03",
      [daily],
      true,
    );
    expect(salvage.applied).toEqual([other]);
    expect(salvage.sections.career).toEqual(full.career);
    const drop = edit({
      op: "delete",
      section: "career",
      old: "Effort 0",
      text: "",
    });
    expect(
      applyUserMemoryEdits(full, [drop, add], "2026-11-03", [daily]).sections
        .career,
    ).toHaveLength(USER_MEMORY_SECTION_LIMITS.career);
    const over = {
      ...full,
      career: [
        ...full.career,
        { text: "Effort 5", date: "2026-10-01" },
        { text: "Effort 6", date: "2026-10-01" },
      ],
    };
    expect(
      applyUserMemoryEdits(over, [drop], "2026-11-03", [daily]).sections.career,
    ).toHaveLength(6);
  });
});

describe("updateUserMemory", () => {
  /** Answers like the Memory kind's attempts: each answer in turn until the
   * request's check accepts one, the last one repeating. */
  const answering = (...answers: Record<string, unknown>[]) => {
    const reasons: string[] = [];
    const request = vi.fn<typeof requestMemoryStructuredOutput>(
      async (call) => {
        for (let attempt = 0; ; attempt += 1) {
          const answer = answers[Math.min(attempt, answers.length - 1)]!;
          const reason = await call.validate?.(answer);
          if (reason === undefined) return answer;
          reasons.push(reason);
          if (attempt + 1 >= modelCallPolicies.memory.attempts)
            throw new ModelCallError("invalid_output", reason);
        }
      },
    );
    return { request, reasons };
  };
  const input = {
    owner,
    human: "Alice",
    date: "2026-11-03",
    cadence: "daily" as const,
    current: memory(),
    evidence: [session, daily],
  };

  it("skips the model when there is nothing to read", async () => {
    const request = vi.fn();
    expect(
      await updateUserMemory({ ...input, evidence: [] }, request),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an answer the edits do not apply to, with the reason", async () => {
    const { request, reasons } = answering(
      {
        edits: [
          edit({ op: "delete", section: "profile", old: "Leads product" }),
        ],
        change_note: "",
      },
      {
        edits: [edit({ text: "Prefers short replies" })],
        change_note: "Added a reply preference",
      },
    );
    const result = await updateUserMemory(input, request);
    expect(result?.sections.communication_and_working_style).toEqual([
      { text: "Prefers short replies", date: "2026-11-03" },
    ]);
    expect(reasons).toEqual([expect.stringContaining("matches no entry")]);
    const sent = JSON.parse(request.mock.calls[0]![0].user);
    expect(sent.human).toBe("Alice");
    expect(sent.evidence[0]).toEqual({
      ref: "S1",
      kind: "session",
      content: session.content,
    });
  });

  it("asks for compaction when the file is over the target", async () => {
    const big = {
      ...emptyUserMemory(),
      profile: Array.from({ length: 12 }, (_, i) => ({
        text: `${i} ${"z".repeat(185)}`,
        date: "2026-10-01",
      })),
      communication_and_working_style: Array.from({ length: 8 }, (_, i) => ({
        text: `${i} ${"z".repeat(185)}`,
        date: "2026-10-01",
      })),
    };
    expect(userMemoryBytes(big)).toBeGreaterThan(
      USER_MEMORY_CAPACITY.target_bytes,
    );
    expect(userMemoryBytes(big)).toBeLessThan(USER_MEMORY_CAPACITY.max_bytes);
    const request = vi.fn().mockResolvedValue({ edits: [], change_note: "" });
    await updateUserMemory({ ...input, current: big, evidence: [] }, request);
    const sent = JSON.parse(request.mock.calls[0]![0].user);
    expect(sent.compact).toBe(true);
    expect(sent.capacity.section_limits).toEqual(USER_MEMORY_SECTION_LIMITS);
  });

  it("asks for compaction when a section is over its limit", async () => {
    const crowded = {
      ...emptyUserMemory(),
      interests: Array.from({ length: 7 }, (_, i) => ({
        text: `Theme ${i}; since 2026-07, most weeks, steady`,
        date: "2026-10-01",
      })),
    };
    const request = vi.fn().mockResolvedValue({ edits: [], change_note: "" });
    await updateUserMemory(
      { ...input, current: crowded, evidence: [] },
      request,
    );
    expect(JSON.parse(request.mock.calls[0]![0].user).compact).toBe(true);
  });

  it("keeps the valid edits of the last answer once every attempt is rejected", async () => {
    const { request, reasons } = answering({
      edits: [
        edit({ text: "x".repeat(201) }),
        edit({ text: "Prefers short replies" }),
      ],
      change_note: "",
    });
    const result = await updateUserMemory(input, request);
    expect(reasons).toHaveLength(modelCallPolicies.memory.attempts);
    expect(result?.sections.communication_and_working_style).toEqual([
      { text: "Prefers short replies", date: "2026-11-03" },
    ]);
    expect(result?.dropped).toBe(1);
  });

  it("fails when the last answer is still over the byte limit", async () => {
    const { request } = answering({
      edits: USER_MEMORY_SECTIONS.flatMap(({ key }) =>
        Array.from({ length: USER_MEMORY_SECTION_LIMITS[key] - 1 }, (_, i) =>
          edit({ section: key, text: `2026-01 ${i} ${"y".repeat(188)}` }),
        ),
      ),
      change_note: "",
    });
    await expect(
      updateUserMemory(
        { ...input, cadence: "weekly", current: emptyUserMemory() },
        request,
      ),
    ).rejects.toThrow("Memory update rejected");
  });

  it("passes a failure before any answer matched the schema", async () => {
    const request = vi
      .fn<typeof requestMemoryStructuredOutput>()
      .mockRejectedValue(new ModelCallError("invalid_output", "not JSON"));
    await expect(updateUserMemory(input, request)).rejects.toMatchObject({
      kind: "invalid_output",
    });
  });
});

describe("maintainUserMemory", () => {
  const memoryStore = (initial: UserMemoryRevision | null = null) => {
    let latest = initial;
    const saves: Parameters<UserMemoryStore["save"]>[2][] = [];
    const store: UserMemoryStore = {
      latest: vi.fn(async () => latest),
      save: vi.fn(async (_owner, base, next) => {
        if ((base?.version ?? 0) !== (latest?.version ?? 0))
          throw new UserMemoryConflictError("changed");
        saves.push(next);
        latest = {
          version: (latest?.version ?? 0) + 1,
          sections: next.sections,
          baseProfileRevisionId: next.baseProfileRevisionId,
        };
        return latest;
      }),
    };
    return { store, saves, latest: () => latest };
  };

  it("reads a large day in parts and saves one version", async () => {
    const { store, saves, latest } = memoryStore();
    const sessions = [
      { path: "evidence/d/sessions/a.md", content: "Alice: likes tea" },
      {
        path: "evidence/d/sessions/b.md",
        content: `Alice: plays chess\n${"x".repeat(100_000)}`,
      },
    ];
    const parts = dailyEvidenceParts(sessions, "Daily body", "2026-11-03");
    expect(parts.map((part) => part.map((e) => e.ref))).toEqual([
      ["S1", "S2", "daily"],
      ["S1"],
    ]);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        edits: [
          edit({
            section: "interests",
            text: "Drinks tea",
            source_ref: "S1",
            quote: "likes tea",
          }),
          edit({
            section: "interests",
            text: "Plays chess",
            source_ref: "S2",
            quote: "plays chess",
          }),
        ],
        change_note: "Tea and chess",
      })
      .mockResolvedValueOnce({ edits: [], change_note: "" });
    const result = await maintainUserMemory(
      { owner, human: "Alice", date: "2026-11-03", cadence: "daily", parts },
      store,
      request,
    );
    expect(result).toEqual({
      changed: true,
      version: 1,
      edits: 2,
      dropped: 0,
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.changeNote).toBe("Tea and chess");
    expect(saves[0]!.evidence[1]).toEqual({
      ref: "S1",
      kind: "session",
      source: "evidence/d/sessions/a.md",
    });
    // The second part continues from the first part's result.
    expect(
      JSON.parse(request.mock.calls[1]![0].user).memory.interests,
    ).toHaveLength(2);
    expect(latest()?.sections.interests).toHaveLength(2);
  });

  it("removes a fact the Human dropped from their Profile", async () => {
    const base = {
      version: 3,
      sections: memory(),
      baseProfileRevisionId: "p1",
    };
    const { store, latest } = memoryStore(base);
    const request = vi.fn().mockResolvedValue({
      edits: [
        edit({
          op: "delete",
          section: "profile",
          old: "Leads product at Acme",
          source_ref: "profile",
        }),
      ],
      change_note: "Removed the Acme role the Profile no longer states.",
    });
    const parts = [
      profileEvidence(
        { id: "p2", markdown: "Alice studies design." },
        { id: "p1", markdown: "Alice leads product at Acme." },
      ),
    ];
    expect(
      await maintainUserMemory(
        {
          owner,
          human: "Alice",
          date: "2026-11-09",
          cadence: "profile",
          parts,
          profileRevisionId: "p2",
        },
        store,
        request,
      ),
    ).toMatchObject({ changed: true, version: 4 });
    // The model sees both Revisions, the earlier one first.
    expect(
      JSON.parse(request.mock.calls[0]![0].user).evidence.map(
        (item: { ref: string }) => item.ref,
      ),
    ).toEqual(["previous_profile", "profile"]);
    expect(latest()?.sections.profile).toEqual([]);
    expect(latest()?.sections.career).toHaveLength(1);
  });

  it("records a Profile Revision that changed nothing", async () => {
    const base = {
      version: 3,
      sections: memory(),
      baseProfileRevisionId: "p1",
    };
    const { store, saves } = memoryStore(base);
    const request = vi.fn().mockResolvedValue({ edits: [], change_note: "" });
    const parts = [
      [{ ref: "profile", kind: "profile" as const, content: "p" }],
    ];
    const input = {
      owner,
      human: "Alice",
      date: "2026-11-03",
      cadence: "profile" as const,
      parts,
    };
    expect(
      await maintainUserMemory(
        { ...input, profileRevisionId: "p2" },
        store,
        request,
      ),
    ).toMatchObject({ changed: true, version: 4 });
    expect(saves[0]!.baseProfileRevisionId).toBe("p2");
    expect(
      await maintainUserMemory(
        { ...input, profileRevisionId: "p2" },
        store,
        request,
      ),
    ).toEqual({ changed: false, edits: 0, dropped: 0 });
  });
});

describe("profileEvidence", () => {
  it("puts the earlier Profile before the new one only when it exists", () => {
    const current = { id: "p2", markdown: "new" };
    expect(profileEvidence(current, null)).toEqual([
      { ref: "profile", kind: "profile", content: "new", source: "p2" },
    ]);
    expect(
      profileEvidence(current, { id: "p1", markdown: "old" }).map((item) => [
        item.ref,
        item.source,
      ]),
    ).toEqual([
      ["previous_profile", "p1"],
      ["profile", "p2"],
    ]);
  });
});
