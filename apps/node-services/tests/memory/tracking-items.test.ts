import { describe, expect, it, vi } from "vitest";
import { MAX_PART_CHARS } from "../../src/memory/session-parts.js";
import {
  refreshPocketNoteTrackingItems,
  trackingSessionPath,
  updateTrackingItems,
  type TrackingItem,
  type TrackingItemStore,
} from "../../src/memory/tracking-items.js";
const owner = { tenantId: "tenant_acme", ownerActorId: "actor_alice" };
const source = "evidence/2026-10-17/sessions/room_1.md";
const fields = {
  kind: "todo" as const,
  content: "Send pricing",
  due_at: null,
  due_text: "next week",
  source_ref: "S1",
};
const item = (i: number, status: "open" | "done" = "open"): TrackingItem => ({
  ...fields,
  source_ref: source,
  source_date: "2026-10-17",
  source_timezone: "Asia/Shanghai",
  id: `ti_${i.toString(16).padStart(32, "0")}`,
  status,
  revision: 3,
  routines: [],
  created_at: "2026-10-16T16:00:00Z",
  updated_at: "2026-10-16T16:00:00Z",
});
function setup(items: TrackingItem[] = []) {
  const apply = vi
    .fn<TrackingItemStore["apply"]>()
    .mockResolvedValue({ items: [], deleted: [] });
  const plan = vi.fn<TrackingItemStore["plan"]>().mockResolvedValue();
  return { apply, plan, store: { list: async () => items, apply, plan } };
}
const input = {
  owner,
  humanName: "Alice",
  date: "2026-10-17",
  sessions: [{ path: source, content: "Next week pricing" }],
};
describe("nightly tracking reconciliation", () => {
  it("updates in place at the observed revision and retains vague time", async () => {
    const { store, apply } = setup([item(1)]);
    await updateTrackingItems(input, store, async ({ user }) =>
      JSON.parse(user).phase === "extract"
        ? { create: [fields] }
        : {
            matched: ["C1"],
            update: [
              {
                ...fields,
                id: item(1).id,
                content: "Send revised pricing",
                status: "open",
              },
            ],
          },
    );
    const changes = apply.mock.calls[0]![1];
    expect(changes.create).toEqual([]);
    expect(changes.update).toEqual([
      {
        ...fields,
        content: "Send revised pricing",
        source_ref: source,
        source_date: "2026-10-17",
        source_timezone: "Asia/Shanghai",
        id: item(1).id,
        expected_revision: 3,
        status: "open",
      },
    ]);
    expect(changes.prune).toBe(true);
  });
  it("checks candidates beyond item 100, including done evidence before cleanup", async () => {
    const { store, apply } = setup(
      Array.from({ length: 151 }, (_, i) =>
        item(i, i === 150 ? "done" : "open"),
      ),
    );
    const pageSizes: number[] = [];
    await updateTrackingItems(input, store, async ({ user }) => {
      const request = JSON.parse(user);
      if (request.phase === "extract") return { create: [fields] };
      pageSizes.push(request.current_items.length);
      return {
        matched: request.current_items.some(
          (i: TrackingItem) => i.status === "done",
        )
          ? ["C1"]
          : [],
        update: [],
      };
    });
    expect(pageSizes).toEqual([100, 51]);
    expect(apply.mock.calls[0]![1]).toEqual({
      create: [],
      update: [],
      delete: [],
      prune: true,
    });
  });
  it("hands new or changed open items back to AnotherMe for Routines", async () => {
    const { store, apply, plan } = setup([item(1)]);
    apply.mockResolvedValue({
      items: [item(1), item(2, "done"), item(3)],
      deleted: [item(3).id],
    });
    await updateTrackingItems(input, store, async ({ user }) =>
      JSON.parse(user).phase === "extract"
        ? { create: [fields] }
        : { matched: [], update: [] },
    );
    expect(plan).toHaveBeenCalledWith(owner, [item(1).id]);
  });

  it("plans nothing when nothing changed", async () => {
    const { store, plan } = setup();
    await updateTrackingItems({ ...input, sessions: [] }, store);
    expect(plan).not.toHaveBeenCalled();
  });

  it("cleans an empty day without a model call", async () => {
    const { store, apply } = setup();
    const model = vi.fn();
    await updateTrackingItems({ ...input, sessions: [] }, store, model);
    expect(model).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(owner, {
      create: [],
      update: [],
      delete: [],
      prune: true,
    });
  });
  it("propagates a revision conflict without falling back to delete and recreate", async () => {
    const { store, apply } = setup([item(1)]);
    apply.mockRejectedValue(new Error("409 conflict"));
    await expect(
      updateTrackingItems(input, store, async ({ user }) =>
        JSON.parse(user).phase === "extract"
          ? { create: [] }
          : {
              matched: [],
              update: [{ ...fields, id: item(1).id, status: "done" }],
            },
      ),
    ).rejects.toThrow("409 conflict");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1].delete).toEqual([]);
  });
  it("rejects unknown evidence before any write", async () => {
    const { store, apply } = setup();
    await expect(
      updateTrackingItems(input, store, async () => ({
        create: [{ ...fields, source_ref: "S9" }],
      })),
    ).rejects.toThrow("Unknown Tracking Item source");
    expect(apply).not.toHaveBeenCalled();
  });
  it("bounds raw Session chunks and retains their evidence identity", async () => {
    const { store } = setup();
    const sizes: number[] = [];
    const content = "x".repeat(MAX_PART_CHARS * 2.5);
    await updateTrackingItems(
      { ...input, sessions: [{ path: source, content }] },
      store,
      async ({ user }) => {
        sizes.push(
          JSON.parse(user).sessions.reduce(
            (n: number, s: { content: string }) => n + s.content.length,
            0,
          ),
        );
        return { create: [] };
      },
    );
    expect(sizes).toHaveLength(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_PART_CHARS);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(content.length);
  });
});
it("keeps only authorized raw Session path shapes", () => {
  expect(trackingSessionPath(`alice/${source}`)).toBe(source);
  expect(() =>
    trackingSessionPath("alice/timeline/daily/2026-10-17.md"),
  ).toThrow("Not a Session path");
});

describe("daytime Pocket Note refresh", () => {
  const notePath = "evidence/2026-11-06/sessions/pocket-note.md";
  const noteItem = (i: number, content: string): TrackingItem => ({
    ...item(i),
    content,
    source_ref: notePath,
    source_date: "2026-11-06",
  });
  const refresh = (note: string | undefined) => ({
    owner,
    humanName: "Alice",
    date: "2026-11-06",
    note,
  });

  it("deletes what the Human removed from the note, keeps the rest, and adds new lines", async () => {
    const kept = noteItem(1, "Send pricing");
    const removed = noteItem(2, "Book a dentist appointment");
    const other = item(3);
    const { store, apply, plan } = setup([kept, removed, other]);
    apply.mockResolvedValue({
      items: [{ ...kept, id: "ti_".padEnd(35, "f"), content: "Call Bob" }],
      deleted: [removed.id],
    });
    const phases: string[] = [];
    await refreshPocketNoteTrackingItems(
      refresh("- Send pricing\n- Call Bob"),
      store,
      async ({ user }) => {
        const request = JSON.parse(user);
        phases.push(request.phase);
        if (request.phase === "retract") {
          // Only the note and the open items it gave are asked about.
          expect(request.sessions).toHaveLength(1);
          expect(request.sessions[0].content).toContain("- Call Bob");
          expect(request.current_items.map((i: TrackingItem) => i.id)).toEqual([
            kept.id,
            removed.id,
          ]);
          return { retract: [removed.id] };
        }
        if (request.phase === "extract")
          return {
            create: [
              { ...fields, source_ref: "S1" },
              {
                ...fields,
                content: "Call Bob",
                due_text: null,
                source_ref: "S1",
              },
            ],
          };
        // The retracted item is no longer compared.
        expect(request.current_items.map((i: TrackingItem) => i.id)).toEqual([
          kept.id,
          other.id,
        ]);
        return { matched: ["C1"], update: [] };
      },
    );
    expect(phases).toEqual(["retract", "extract", "reconcile"]);
    const changes = apply.mock.calls[0]![1];
    expect(changes.delete).toEqual([{ id: removed.id, expected_revision: 3 }]);
    expect(changes.create).toEqual([
      expect.objectContaining({ content: "Call Bob", source_ref: notePath }),
    ]);
    // Done and expired items are left for the nightly cleanup.
    expect(changes.prune).toBe(false);
    expect(plan).toHaveBeenCalledWith(owner, ["ti_".padEnd(35, "f")]);
  });

  it("deletes every open item from the note when the page is emptied, without asking the model", async () => {
    const done = { ...noteItem(2, "Ship it"), status: "done" as const };
    const { store, apply } = setup([
      noteItem(1, "Send pricing"),
      done,
      item(3),
    ]);
    const request = vi.fn();
    await refreshPocketNoteTrackingItems(refresh("  "), store, request);
    expect(request).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledExactlyOnceWith(owner, {
      create: [],
      update: [],
      delete: [{ id: item(1).id, expected_revision: 3 }],
      prune: false,
    });
  });

  it("skips the retract question when the note has given no open items yet", async () => {
    const { store } = setup([item(3)]);
    const phases: string[] = [];
    await refreshPocketNoteTrackingItems(
      refresh("- Send pricing"),
      store,
      async ({ user }) => {
        const { phase } = JSON.parse(user);
        phases.push(phase);
        return phase === "extract"
          ? { create: [] }
          : { matched: [], update: [] };
      },
    );
    expect(phases).toEqual(["extract", "reconcile"]);
  });
});
