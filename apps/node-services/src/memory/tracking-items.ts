import { localDateWindow, localTimeZone } from "./date.js";
// Memory reconciles authorized raw Sessions; TeamHub owns item mutations.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTeamHubTrackingItemClient } from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import { loadAnotherMeSubjects } from "./collector.js";
import { requestMemoryStructuredOutput } from "./llm.js";
import { promptRoot } from "./paths.js";
import { writeMemoryLog } from "./run-telemetry.js";
import {
  loadPocketNote,
  pocketNoteSessionContent,
} from "./pocket-note-source.js";
import {
  SESSION_PATH_PATTERN,
  pocketNoteSessionPath,
} from "./session-source.js";
import { teamHubContentAccess } from "./teamhub-content.js";
import { teamHubFetch } from "./teamhub-transport.js";
import { sessionParts } from "./session-parts.js";

type S = components["schemas"];
export type TrackingItem = S["TrackingItem"];
export type TrackingItemCreate = S["TrackingItemCreate"];
export interface TrackingOwner {
  tenantId: string;
  ownerActorId: string;
}
export interface TrackingSession {
  path: string;
  content: string;
}
export interface TrackingItemStore {
  list(owner: TrackingOwner): Promise<TrackingItem[]>;
  apply(
    owner: TrackingOwner,
    changes: S["TrackingItemChanges"],
  ): Promise<S["TrackingItemResult"]>;
  /** Asks the Human's AnotherMe to plan Routines for these open items. */
  plan(owner: TrackingOwner, itemIds: readonly string[]): Promise<void>;
}
type Evidence = Pick<
  TrackingItem,
  "kind" | "content" | "due_at" | "due_text" | "source_ref"
>;
const fields = {
  kind: { type: "string", enum: ["todo", "question", "meeting"] },
  content: { type: "string", minLength: 1, maxLength: 200 },
  due_at: { type: ["string", "null"] },
  due_text: { type: ["string", "null"] },
  source_ref: { type: "string" },
};
const objectSchema = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arrayOf = (items: object) => ({ type: "array", maxItems: 200, items });
function evidence(
  value: Evidence,
  refs: Map<string, string>,
  date: string,
): S["TrackingItemFields"] {
  const source = refs.get(value.source_ref);
  if (!source) throw new Error("Unknown Tracking Item source");
  if (
    !["todo", "question", "meeting"].includes(value.kind) ||
    !value.content?.trim() ||
    [...value.content.trim()].length > 200
  )
    throw new Error(
      "Tracking Item content must be 1-200 characters with a valid kind",
    );
  if (
    value.due_text !== null &&
    (typeof value.due_text !== "string" ||
      !value.due_text.trim() ||
      value.due_text.length > 500)
  )
    throw new Error("Invalid due_text");
  let due = value.due_at;
  if (due !== null) {
    if (
      typeof due !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(due) ||
      !Number.isFinite(Date.parse(due))
    )
      throw new Error("Tracking Item due_at is not an ISO time");
    due = new Date(due).toISOString();
  }
  return {
    kind: value.kind,
    content: value.content.trim(),
    due_at: due,
    due_text: value.due_text,
    source_ref: source,
    source_date: date,
    source_timezone: localTimeZone(),
  };
}
export async function updateTrackingItems(
  input: {
    owner: TrackingOwner;
    humanName: string;
    date: string;
    sessions: readonly TrackingSession[];
    /** Open items to delete with their Routines, left out of the comparison. */
    retract?: readonly TrackingItem[];
    /** Whether TeamHub also deletes done and expired items; the nightly run does. */
    prune?: boolean;
  },
  store: TrackingItemStore,
  request: typeof requestMemoryStructuredOutput = requestMemoryStructuredOutput,
): Promise<{
  created: number;
  updated: number;
  deleted: number;
  planned: number;
}> {
  // Done and expired facts remain visible through the complete reconciliation.
  const retracted = new Set(input.retract?.map((item) => item.id));
  const items = new Map(
    (await store.list(input.owner))
      .filter((item) => !retracted.has(item.id))
      .map((item) => [item.id, item]),
  );
  const creates = new Map<string, TrackingItemCreate>();
  const updates = new Map<string, S["TrackingItemUpdate"]>();
  const system = await fs.readFile(
    path.join(promptRoot, "tracking", "tracking-items.md"),
    "utf8",
  );
  for (const part of sessionParts(input.sessions)) {
    const refs = new Map(part.map((s, i) => [`S${i + 1}`, s.path]));
    const context = {
      human: input.humanName,
      date: input.date,
      timezone: localTimeZone(),
      sessions: part.map((s, i) => ({
        source_ref: `S${i + 1}`,
        content: s.content,
      })),
    };
    const extracted = (await request({
      owner: input.owner,
      system,
      user: JSON.stringify({ ...context, phase: "extract" }),
      schemaName: "tracking_extract",
      schema: objectSchema({ create: arrayOf(objectSchema(fields)) }),
      reasoningEffort: "medium",
    })) as { create: Evidence[] };
    if (!Array.isArray(extracted.create) || extracted.create.length > 200)
      throw new Error("Invalid Tracking Item extraction");
    const candidates = new Map(
      extracted.create.map((v, i) => [
        `C${i + 1}`,
        evidence(v, refs, input.date),
      ]),
    );
    // Compare every candidate with every bounded page before accepting it.
    const existing = [...items.values()];
    for (let offset = 0; offset < existing.length; offset += 100) {
      const page = existing.slice(offset, offset + 100);
      // The schema allows only this page's candidate and item IDs and today's
      // Session references, so a confused reply cannot fail the whole night.
      const sessionRefs = [...refs.keys()];
      const pathRefs = new Map([...refs].map(([ref, path]) => [path, ref]));
      const result = (await request({
        owner: input.owner,
        system,
        user: JSON.stringify({
          ...context,
          phase: "reconcile",
          current_items: page,
          candidates: [...candidates].map(([candidate_id, item]) => ({
            candidate_id,
            ...item,
            source_ref: pathRefs.get(item.source_ref) ?? item.source_ref,
          })),
        }),
        schemaName: "tracking_reconcile",
        schema: objectSchema({
          matched: candidates.size
            ? arrayOf({ type: "string", enum: [...candidates.keys()] })
            : { type: "array", maxItems: 0, items: { type: "string" } },
          update: arrayOf(
            objectSchema({
              ...fields,
              source_ref: { type: "string", enum: sessionRefs },
              id: { type: "string", enum: page.map((item) => item.id) },
              status: { type: "string", enum: ["open", "done"] },
            }),
          ),
        }),
        reasoningEffort: "medium",
      })) as {
        matched: string[];
        update: (Evidence & { id: string; status: "open" | "done" })[];
      };
      if (
        !Array.isArray(result.matched) ||
        !Array.isArray(result.update) ||
        result.update.length > 100
      )
        throw new Error("Invalid Tracking Item reconciliation");
      for (const id of new Set(result.matched)) candidates.delete(id);
      const changed = new Set<string>();
      for (const update of result.update) {
        const original = page.find((item) => item.id === update.id);
        if (!original) throw new Error("Unknown Tracking Item update");
        if (update.status !== "open" && update.status !== "done")
          throw new Error("Invalid Tracking Item status");
        // A repeated update or a reopened done item is ignored: done items
        // are never revived, and one reply must not fail the whole night.
        if (
          changed.has(update.id) ||
          (original.status === "done" && update.status === "open")
        )
          continue;
        changed.add(update.id);
        const next = evidence(update, refs, input.date);
        items.set(update.id, { ...original, ...next, status: update.status });
        const pending = creates.get(update.id);
        if (pending) {
          if (update.status === "done") creates.delete(update.id);
          else
            creates.set(update.id, {
              ...next,
              idempotency_key: pending.idempotency_key,
            });
        } else if (!update.id.startsWith("new_"))
          updates.set(update.id, {
            ...next,
            id: update.id,
            status: update.status,
            expected_revision: original.revision,
          });
      }
    }
    for (const item of candidates.values()) {
      const key = createHash("sha256")
        .update(JSON.stringify([item.source_ref, item.kind, item.content]))
        .digest("hex");
      const id = `new_${key}`;
      if (items.has(id)) continue;
      creates.set(id, { ...item, idempotency_key: key });
      items.set(id, {
        ...item,
        id,
        status: "open",
        revision: 1,
        created_at: localDateWindow(input.date).startIso,
        updated_at: localDateWindow(input.date).startIso,
        routines: [],
      });
    }
  }
  const commands: Array<{
    create?: TrackingItemCreate;
    update?: S["TrackingItemUpdate"];
  }> = [
    ...[...creates.values()].map((create) => ({ create })),
    ...[...updates.values()].map((update) => ({ update })),
  ];
  let deleted = 0;
  const changed = new Set<string>();
  const retractions = (input.retract ?? []).map((item) => ({
    id: item.id,
    expected_revision: item.revision,
  }));
  // Even an empty day performs cleanup, after retaining done evidence above.
  for (let offset = 0; offset < Math.max(1, commands.length); offset += 200) {
    const batch = commands.slice(offset, offset + 200);
    const result = await store.apply(input.owner, {
      create: batch.flatMap((c) => (c.create ? [c.create] : [])),
      update: batch.flatMap((c) => (c.update ? [c.update] : [])),
      delete: offset === 0 ? retractions : [],
      prune: (input.prune ?? true) && offset + 200 >= commands.length,
    });
    deleted += result.deleted.length;
    for (const item of result.items)
      if (item.status === "open") changed.add(item.id);
    for (const id of result.deleted) changed.delete(id);
  }
  // New or changed open matters go back to AnotherMe, which decides their
  // Routines; Memory never writes reminders itself.
  const planned = [...changed];
  for (let offset = 0; offset < planned.length; offset += 200)
    await store.plan(input.owner, planned.slice(offset, offset + 200));
  return {
    created: creates.size,
    updated: updates.size,
    deleted,
    planned: planned.length,
  };
}
/**
 * The daytime refresh after the Human changed today's Pocket Note. Only the
 * note is read: open items it gave that it no longer mentions are deleted with
 * their Routines, and the rest is the nightly comparison against every item.
 * The midnight Daily still reads the whole day.
 */
export async function refreshPocketNoteTrackingItems(
  input: {
    owner: TrackingOwner;
    humanName: string;
    date: string;
    /** The note as it is now; undefined when the page is empty or deleted. */
    note: string | undefined;
  },
  store: TrackingItemStore,
  request: typeof requestMemoryStructuredOutput = requestMemoryStructuredOutput,
): ReturnType<typeof updateTrackingItems> {
  const notePath = pocketNoteSessionPath(input.date);
  const fromNote = (await store.list(input.owner)).filter(
    (item) => item.status === "open" && item.source_ref === notePath,
  );
  const text = input.note?.trim();
  const base = {
    owner: input.owner,
    humanName: input.humanName,
    date: input.date,
    prune: false,
  };
  if (!text)
    return updateTrackingItems(
      { ...base, sessions: [], retract: fromNote },
      store,
      request,
    );
  const session = {
    path: notePath,
    content: pocketNoteSessionContent(input.date, text),
  };
  let retract: TrackingItem[] = [];
  if (fromNote.length) {
    const result = (await request({
      owner: input.owner,
      system: await fs.readFile(
        path.join(promptRoot, "tracking", "tracking-items.md"),
        "utf8",
      ),
      user: JSON.stringify({
        human: input.humanName,
        date: input.date,
        timezone: localTimeZone(),
        phase: "retract",
        sessions: [{ source_ref: "S1", content: session.content }],
        current_items: fromNote,
      }),
      schemaName: "tracking_retract",
      schema: objectSchema({
        retract: {
          type: "array",
          maxItems: fromNote.length,
          items: { type: "string", enum: fromNote.map((item) => item.id) },
        },
      }),
      reasoningEffort: "medium",
    })) as { retract: string[] };
    if (!Array.isArray(result.retract))
      throw new Error("Invalid Tracking Item retraction");
    const ids = new Set(result.retract);
    retract = fromNote.filter((item) => ids.has(item.id));
  }
  return updateTrackingItems(
    { ...base, sessions: [session], retract },
    store,
    request,
  );
}

/** Runs the daytime Pocket Note refresh for the Human's AnotherMe, if any. */
export async function updatePocketNoteTrackingItems(
  tenantId: string,
  ownerActorId: string,
  date: string,
): Promise<void> {
  const subject = (await loadAnotherMeSubjects()).find(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.representedHumanActorId === ownerActorId,
  );
  if (!subject) {
    writeMemoryLog("memory_pocket_note_tracking_skipped", {
      tenant_id: tenantId,
      owner_actor_id: ownerActorId,
      date,
      reason: "no_another_me",
    });
    return;
  }
  const result = await refreshPocketNoteTrackingItems(
    {
      owner: { tenantId, ownerActorId },
      humanName: subject.representedHumanDisplayName,
      date,
      note: await loadPocketNote(subject, date),
    },
    teamHubTrackingItemStore(),
  );
  writeMemoryLog("memory_pocket_note_tracking_updated", {
    memory_subject_key: subject.memorySubjectKey,
    date,
    ...result,
  });
}

export function trackingSessionPath(logicalPath: string): string {
  const relative = logicalPath.slice(logicalPath.indexOf("/") + 1);
  if (!SESSION_PATH_PATTERN.test(relative))
    throw new Error(`Not a Session path: ${logicalPath}`);
  return relative;
}
export function teamHubTrackingItemStore(): TrackingItemStore {
  const access = teamHubContentAccess();
  const client = createTeamHubTrackingItemClient({
    baseUrl: access.baseUrl,
    serviceToken: access.token,
    fetch: teamHubFetch(access.fetch),
  });
  return {
    async list(owner) {
      const items: TrackingItem[] = [];
      let cursor = "";
      do {
        const response = await client.list(
          owner.ownerActorId,
          { limit: 200, cursor, include_closed: true },
          AbortSignal.timeout(30_000),
        );
        if (!response.ok)
          throw new Error(`Tracking Item list failed: ${response.status}`);
        const page = (await response.json()) as S["TrackingItemPage"];
        items.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    },
    async apply(owner, changes) {
      const response = await client.apply(
        owner.ownerActorId,
        changes,
        AbortSignal.timeout(30_000),
      );
      if (!response.ok)
        throw new Error(`Tracking Item command failed: ${response.status}`);
      return (await response.json()) as S["TrackingItemResult"];
    },
    async plan(owner, itemIds) {
      const response = await client.plan(
        owner.ownerActorId,
        { item_ids: [...itemIds] },
        AbortSignal.timeout(30_000),
      );
      if (!response.ok)
        throw new Error(`Tracking Item plan failed: ${response.status}`);
    },
  };
}
/** The nightly step after the day read: Tracking Items from the day's
 * Sessions, reconciled against the Human's open items. A meeting's own
 * update reads only its transcript and leaves the cleanup to the night. */
export async function updateDailyTrackingItems(
  memorySubjectKey: string,
  date: string,
  sessionFiles: readonly { path: string; content: string }[],
  scope: "day" | "meeting" = "day",
): Promise<void> {
  const subject = (await loadAnotherMeSubjects()).find(
    (candidate) => candidate.memorySubjectKey === memorySubjectKey,
  );
  if (!subject)
    throw new Error(
      `No AnotherMe subject for Tracking Items: ${memorySubjectKey}`,
    );
  const sessions = sessionFiles.map((file) => ({
    path: trackingSessionPath(file.path),
    content: file.content,
  }));
  const result = await updateTrackingItems(
    {
      owner: {
        tenantId: subject.tenantId,
        ownerActorId: subject.representedHumanActorId,
      },
      humanName: subject.representedHumanDisplayName,
      date,
      sessions,
      prune: scope === "day",
    },
    teamHubTrackingItemStore(),
  );
  writeMemoryLog("memory_tracking_items_updated", {
    memory_subject_key: memorySubjectKey,
    date,
    scope,
    ...result,
  });
}
