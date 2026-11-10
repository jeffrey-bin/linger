import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDayRead } from "../../src/memory/day-read.js";
import type { DailyCollection } from "../../src/memory/daily-cli.js";
import { setMemoryModelCall } from "../../src/memory/llm.js";
import {
  emptyUserMemory,
  UserMemoryConflictError,
  type UserMemoryRevision,
  type UserMemoryStore,
} from "../../src/memory/user-memory.js";
import type { ModelChainCallRequest } from "../../src/runtime-model-call.js";
import { stubModelCall } from "../model-call-stub.js";

const subjectKey = "agent_alice";
const date = "2026-09-02";
const subject = {
  tenantId: "tenant_1",
  agentActorId: "agent_alice",
  agentManagementId: "agent_alice",
  agentDisplayName: "Another Me",
  representedHumanActorId: "actor_alice",
  representedHumanDisplayName: "Alice",
  representedHumanAccountId: null,
  memorySubjectKey: subjectKey,
};

const daily = {
  title: "Moving day",
  description: "Planned the move.",
  source_refs: ["room-alpha"],
  daily_work: [{ topic: "Move", text: "Planned the move to Berlin." }],
  resolved_items: [],
  unresolved_items: [],
  tomorrow_focus: [],
  changes_compared_to_yesterday: [],
  pattern: [],
};

function memoryEdit(quote: string) {
  return {
    edits: [
      {
        op: "add",
        section: "profile",
        old: "",
        text: "Moving to Berlin next month.",
        source_ref: "room-alpha",
        quote,
      },
    ],
    change_note: "Moving.",
  };
}

function memoryStore() {
  const saved: UserMemoryRevision[] = [];
  const store: UserMemoryStore = {
    latest: async () => saved.at(-1) ?? null,
    save: async (_owner, base, next) => {
      if ((base?.version ?? 0) !== saved.length)
        throw new UserMemoryConflictError("memory.md changed meanwhile");
      const revision = {
        version: saved.length + 1,
        sections: next.sections,
        baseProfileRevisionId: next.baseProfileRevisionId,
      };
      saved.push(revision);
      return revision;
    },
  };
  return { store, saved };
}

afterEach(() => setMemoryModelCall(() => undefined));

function answerWith(
  replies: Record<string, unknown>[],
  requests: ModelChainCallRequest[] = [],
  beforeEach: () => void | Promise<void> = () => undefined,
) {
  const call = vi.fn(async (request: ModelChainCallRequest) => {
    requests.push(request);
    await beforeEach();
    return { model: "test", output: replies.shift()! };
  });
  setMemoryModelCall(() =>
    stubModelCall({
      chain: (_spec, body) =>
        body({
          signal: new AbortController().signal,
          call,
          text: () => Promise.reject(new Error("unused")),
          workspace: () => Promise.reject(new Error("unused")),
        }),
    }),
  );
}

function dayCollection(memoryRoot: string): DailyCollection {
  return {
    schemaVersion: 4,
    date,
    timeZone: "UTC",
    generatedAt: "2026-09-03T00:00:00.000Z",
    source: { memoryRoot },
    memorySubjectKey: subjectKey,
    sessionFiles: [
      {
        path: "teamhub://rooms/room-alpha/messages",
        content:
          "## 2026-09-02T10:00:00.000Z · Alice\n\nI'm moving to Berlin next month.",
      },
    ],
    previousDailyFiles: [],
    requiredOutputs: {
      dailyMemoryPath: `${subjectKey}/timeline/daily/${date}.md`,
    },
  };
}

describe("runDayRead", () => {
  it.each([true, false])("keeps valid edits (retry=%s)", async (fixed) => {
    const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "day-read-"));
    const replies = [
      {
        actions: [
          {
            tool: "propose",
            object: "memory.md",
            target: "memory.md",
            payload: {
              ...memoryEdit("moving"),
              edits: [
                { ...memoryEdit("moving").edits[0], section: "nowhere" },
                ...memoryEdit("moving to Berlin next month").edits,
              ],
            },
          },
          {
            tool: "propose",
            object: "daily",
            target: "daily",
            payload: daily,
          },
          { tool: "finish", summary: "done" },
        ],
      },
      {
        actions: [
          ...(fixed
            ? [
                {
                  tool: "propose",
                  object: "memory.md",
                  target: "memory.md",
                  payload: memoryEdit("moving to Berlin next month"),
                },
              ]
            : []),
          { tool: "finish", summary: "done" },
        ],
      },
    ];
    const requests: ModelChainCallRequest[] = [];
    answerWith(replies, requests);
    const collection = dayCollection(memoryRoot);
    const { store, saved } = memoryStore();
    const result = await runDayRead(
      { date, memoryRoot, memorySubjectKey: subjectKey, subject } as never,
      collection,
      store,
    );

    expect(requests.map((request) => request.step)).toEqual([
      "day-read/1",
      "day-read/2",
    ]);
    expect(requests[0]!.instructions).toContain(
      "the memory.md edits, then the Daily report",
    );
    // memory.md is told which cadence's rules apply to one day.
    expect(requests[0]!.input).toContain('"cadence":"daily"');
    expect(requests[1]!.input).toContain("unknown section nowhere");
    expect(result).toMatchObject({
      merged: true,
      memory: { changed: true, edits: 1, dropped: fixed ? 0 : 1 },
    });
    expect(saved[0]!.sections.profile).toEqual([
      { text: "Alice", date },
      expect.objectContaining({ text: "Moving to Berlin next month." }),
    ]);
    const report = await fs.readFile(
      path.join(
        memoryRoot,
        subjectKey,
        "memory",
        "timeline",
        "daily",
        `${date}.md`,
      ),
      "utf8",
    );
    expect(report).toContain("Planned the move to Berlin.");
  });

  it("puts the day's edits onto a memory.md version written meanwhile", async () => {
    const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "day-read-"));
    const { store, saved } = memoryStore();
    const profile = {
      text: "Works at Linger.",
      date: "2026-09-02",
    };
    let synced = false;
    answerWith(
      [
        {
          actions: [
            {
              tool: "propose",
              object: "memory.md",
              target: "memory.md",
              payload: memoryEdit("moving to Berlin next month"),
            },
            {
              tool: "propose",
              object: "daily",
              target: "daily",
              payload: daily,
            },
            { tool: "finish", summary: "done" },
          ],
        },
      ],
      [],
      // A Profile sync writes memory.md while the day is being read.
      async () => {
        if (synced) return;
        synced = true;
        await store.save({ tenantId: "", ownerActorId: "" }, null, {
          sections: {
            ...emptyUserMemory(),
            profile: [profile],
          },
          baseProfileRevisionId: "profile_revision_1",
          source: "profile",
          changeNote: "",
          evidence: [],
        });
      },
    );
    const result = await runDayRead(
      { date, memoryRoot, memorySubjectKey: subjectKey, subject } as never,
      dayCollection(memoryRoot),
      store,
    );

    expect(result.memory).toMatchObject({ changed: true, edits: 1 });
    expect(saved).toHaveLength(2);
    expect(saved[1]!.baseProfileRevisionId).toBe("profile_revision_1");
    expect(saved[1]!.sections.profile).toEqual([
      profile,
      expect.objectContaining({ text: "Moving to Berlin next month." }),
    ]);
  });
});
