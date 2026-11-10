import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browseMeetings,
  meetingDisplayPath,
  readMeetingSummary,
} from "../../src/memory/meeting-browser.js";
import type { MeetingRow } from "../../src/memory/ready-meetings.js";
import { writeSessionlyCheckpoint } from "../../src/memory/sessionly-checkpoint.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  subjects: vi.fn(),
  wiki: vi.fn(),
}));
vi.mock("../../src/memory/collector.js", () => ({
  loadWikiGraphSubjectsForActor: mocks.subjects,
}));
vi.mock("../../src/memory/database.js", () => ({
  memoryDatabase: () => mocks.query,
}));
vi.mock("../../src/memory/wiki-index.js", () => ({
  readIndexedWiki: mocks.wiki,
}));
let root: string;
/** The indexed published Wiki: page path to Markdown. */
let published: Map<string, string>;
const summaryPath = `sessions/2026-09-24/capture_12345678.md`;
const row: MeetingRow = {
  id: "capture_12345678",
  room_id: "room_a",
  started_at: new Date("2026-09-23T15:59:58Z"),
  updated_at: new Date("2026-09-24T00:02:00Z"),
  transcript_created_at: new Date("2026-09-23T16:02:00Z"),
  recording_document_id: "audio",
  recording_version_id: "audio_v1",
  recording_filename: "capture.m4a",
  transcript_document_id: "text",
  transcript_version_id: "text_v1",
  transcript_sha256: "hash",
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-browser-"));
  published = new Map();
  mocks.query.mockResolvedValue([row]);
  mocks.wiki.mockImplementation(
    async (_tenant: string, _owner: string, keys?: string[]) => ({
      revision: "wiki_v1",
      pages: [...published]
        .filter(([key]) => !keys || keys.includes(key))
        .map(([key, content]) => ({ key, title: key, content, metadata: {} })),
    }),
  );
  mocks.subjects.mockResolvedValue([
    { tenantId: "tenant_a", agentManagementId: "agent_a" },
  ]);
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function publishSummary(
  sourceVersion = "text_v1:hash",
  subject = "agent_a",
) {
  published.set(
    summaryPath,
    `---
type: Session
sources:
  - id: R1
    resource: teamhub://documents/text/versions/${sourceVersion.split(":")[0]}
---

# Meeting summary

Decisions.
`,
  );
  const state = path.join(root, subject, "memory-state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(
    path.join(state, "wiki-file-paths.json"),
    JSON.stringify({
      [summaryPath]: "timeline/meetings/2026-09-23 23-59-58.md",
    }),
  );
  await writeSessionlyCheckpoint(root, {
    date: "2026-09-24",
    memorySubjectKey: subject,
    roomId: row.room_id,
    recordingId: row.id,
    sourceVersion,
    lastMessage: {
      messageId: "text_v1",
      createdAt: row.updated_at.toISOString(),
    },
  });
}

describe("Meetings virtual browser", () => {
  it("uses the local start time to the second, not completion or transcript date", () => {
    expect(meetingDisplayPath(row.started_at)).toBe(
      "Meetings/2026/09/23/Meeting 23-59-58",
    );
    expect(meetingDisplayPath(new Date("2026-09-23T16:00:00Z"))).toBe(
      "Meetings/2026/09/24/Meeting 00-00-00",
    );
    vi.stubEnv("TZ", "America/New_York");
    expect(meetingDisplayPath(new Date("2026-09-23T16:00:00Z"))).toBe(
      "Meetings/2026/09/23/Meeting 12-00-00",
    );
  });
  it("shows historical ready files without requiring a summary or AnotherMe", async () => {
    mocks.subjects.mockResolvedValue([]);
    const page = await browseMeetings({
      dataRoot: root,
      tenantId: "tenant_a",
      ownerActorId: "human_a",
    });
    expect(page.items[0]?.meeting).toMatchObject({
      summary_ready: false,
      recording_filename: "recording.m4a",
      transcript_version_id: "text_v1",
    });
    expect(await fs.readdir(root)).toEqual([]);
    const sql = mocks.query.mock.calls[0]![0].join("?");
    expect(sql).toContain("FROM memory_source.finalized_meetings");
    expect(sql).toContain(
      "memory_source.human_can_read_document(?, tenant_id, recording_document_id)",
    );
    expect(sql).toContain(
      "memory_source.human_can_read_document(?, tenant_id, transcript_document_id)",
    );
  });
  it("maps committed summary across midnight without copying or changing the Session", async () => {
    await publishSummary();
    const input = {
      dataRoot: root,
      tenantId: "tenant_a",
      ownerActorId: "human_a",
    };
    const page = await browseMeetings(input);
    expect(page.items[0]?.meeting).toMatchObject({
      summary_ready: true,
      summary_path: "timeline/meetings/2026-09-23 23-59-58.md",
    });
    expect(page.items[0]?.content).toBe("");
    const detail = await browseMeetings({
      ...input,
      entryId: page.items[0]!.id,
    });
    expect(detail.items[0]?.content).toContain("Decisions.");
    expect(mocks.wiki).toHaveBeenCalledWith("tenant_a", "human_a", [
      summaryPath,
    ]);
  });
  it("does not expose stale summaries or summaries from another subject", async () => {
    await publishSummary("text_old:old");
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toBeUndefined();
    await publishSummary("text_v1:hash", "agent_other");
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toBeUndefined();
    await publishSummary("text_v1:hashother");
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toBeUndefined();
  });
  it("keeps the summary when the recorder's private notes extend the source version", async () => {
    await publishSummary("text_v1:hash:0123456789abcdef");
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toMatchObject({
      path: "sessions/2026-09-24/capture_12345678.md",
    });
  });
  it("never presents collected Raw as a generated meeting summary", async () => {
    await publishSummary();
    const raw = path.join(
      root,
      "agent_a/memory-state/evidence/2026-09-24/sessions/recordings",
      row.id + ".md",
    );
    await fs.mkdir(path.dirname(raw), { recursive: true });
    await fs.writeFile(
      raw,
      "# Recording\n\n## Authoritative Raw Evidence\n\nFull transcript.",
    );
    published.clear();
    const page = await browseMeetings({
      dataRoot: root,
      tenantId: "tenant_a",
      ownerActorId: "human_a",
    });
    expect(page.items[0]?.meeting?.summary_ready).toBe(false);
    expect(page.items[0]?.meeting?.summary_path).toBeUndefined();
    expect(await fs.readFile(raw, "utf8")).toContain("Full transcript.");
  });

  it.each([
    "---\ntype: Session\nsources:\n  - resource: teamhub://documents/text/versions/old\n---\n\nOld summary.",
    "---\ntype: Session\nsources:\n  - resource: teamhub://documents/unrelated/versions/text_v1\n---\n\nOther recording.",
    "---\ntype: Session\n---\n\nUncited summary.",
    "---\ntype: Session Evidence\nsources:\n  - resource: teamhub://documents/text/versions/text_v1\n---\n\nRaw evidence.",
  ])("rejects a Session without current raw provenance", async (content) => {
    await publishSummary();
    published.set(summaryPath, content);
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toBeUndefined();
  });

  it("requires the published page as well as the committed checkpoint", async () => {
    await publishSummary();
    published.delete(summaryPath);
    expect(
      await readMeetingSummary(root, "agent_a", row, published),
    ).toBeUndefined();
  });
  it("keeps duplicate-second meetings separate and rejects unknown or unauthorized IDs", async () => {
    mocks.query.mockResolvedValue([row, { ...row, id: "capture_87654321" }]);
    const input = {
      dataRoot: root,
      tenantId: "tenant_a",
      ownerActorId: "human_a",
    };
    const first = await browseMeetings({ ...input, limit: 1 });
    const second = await browseMeetings({
      ...input,
      limit: 1,
      cursor: first.next_cursor,
    });
    expect(first.items[0]?.path).not.toBe(second.items[0]?.path);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    mocks.query.mockResolvedValue([]);
    expect(
      (await browseMeetings({ ...input, entryId: first.items[0]!.id })).items,
    ).toEqual([]);
  });
});
