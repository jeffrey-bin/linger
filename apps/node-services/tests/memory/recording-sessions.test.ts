import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryPersonalKnowledge,
  readPersonalKnowledgeEvidence,
} from "../../src/memory/knowledge-query.js";
import { agentWorkspaceRoot, memoryFilePath } from "../../src/memory/paths.js";
import {
  collectRecordingSession,
  recordingCollection,
  recordingSourceVersion,
  renderRecordingPrivateContext,
  type RecordingCandidate,
} from "../../src/memory/recording-collector.js";
import {
  listRawSourcesForAgent,
  readRawSource,
} from "../../src/memory/search/source-store.js";
import {
  readSessionlyCheckpoint,
  sourceVersionCoversTranscript,
} from "../../src/memory/sessionly-checkpoint.js";
import { runWikiSessionSources } from "../../src/memory/sync-runners.js";
import type { AnotherMeSubject } from "../../src/memory/types.js";
import { RawDatabaseFixture } from "./raw-database-fixture.js";

const mocks = vi.hoisted(() => ({
  subjects: vi.fn(),
  recordings: vi.fn(),
  daily: vi.fn(),
  model: vi.fn(),
  tracking: vi.fn(),
}));
vi.mock("../../src/memory/tracking-items.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/memory/tracking-items.js")
  >()),
  updateDailyTrackingItems: mocks.tracking,
}));
vi.mock("../../src/memory/collector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: mocks.subjects,
  collectDaily: mocks.daily,
}));
vi.mock("../../src/memory/recording-collector.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/memory/recording-collector.js")
  >()),
  loadRecordingCandidates: mocks.recordings,
}));
vi.mock("../../src/memory/llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory/llm.js")>()),
  runValidatedMemoryModelUpdate: mocks.model,
}));

const subject: AnotherMeSubject = {
  tenantId: "tenant_1",
  agentActorId: "actor_agent",
  agentManagementId: "agent_1",
  agentDisplayName: "Agent",
  representedHumanActorId: "human_1",
  representedHumanDisplayName: "Alice",
  representedHumanAccountId: "account_1",
  memorySubjectKey: "agent_1",
};
const transcript =
  "# Recording Transcript\n\n[00:00:00 - 00:00:12] The Cobalt limit is 37.5k USD.\n";
const candidate = (
  captureId = "capture_1",
  content = transcript,
): RecordingCandidate => ({
  captureId,
  tenantId: "tenant_1",
  roomId: "room_1",
  roomName: "Unrelated private chat",
  documentId: `document_${captureId}`,
  documentVersionId: `version_${captureId}`,
  sha256: createHash("sha256").update(content).digest("hex"),
  sizeBytes: Buffer.byteLength(content),
  startedAt: "2026-09-14T23:55:00+08:00",
  endedAt: "2026-09-15T00:20:00+08:00",
  readyAt: "2026-09-15T00:25:00+08:00",
  date: "2026-09-15",
  creatorId: "human_1",
  creatorName: "Alice",
  agentIsMember: false,
  humanIsMember: true,
});
let root: string;
const options = () => ({
  date: "2026-09-15",
  memoryRoot: root,
  concurrency: 1,
});
const argv = (captureId = "capture_1") => [
  "run",
  "--date",
  "2026-09-15",
  "--memory-root",
  root,
  "--memory-subject-key",
  "agent_1",
  "--recording-id",
  captureId,
];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-recording-"));
  mocks.subjects.mockResolvedValue([subject]);
  mocks.recordings.mockResolvedValue([candidate()]);
  mocks.daily.mockReset();
  mocks.tracking.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("TEAMHUB_BASE_URL", "http://teamhub.test");
  vi.stubEnv("LINGER_SECRET_SEED", "test-seed-0123456789abcdef0123456789");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(transcript)),
  );
  mocks.model.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("independent Recording Wiki sources", () => {
  it("updates the same Capture file when its formal transcript version changes", async () => {
    await runWikiSessionSources(argv());
    const text = `${transcript}\n[00:01:00] Updated evidence.`;
    mocks.recordings.mockResolvedValue([
      { ...candidate("capture_1", text), documentVersionId: "version_revised" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(text)),
    );
    await runWikiSessionSources(argv());
    const staged = await fs.readFile(
      path.join(
        root,
        "agent_1/memory-state/evidence/2026-09-15/sessions/recordings/capture_1.md",
      ),
      "utf8",
    );
    expect(staged).toContain("Updated evidence.");
    expect(staged).toContain('represented_human_actor_id: "human_1"');
    expect(staged).toContain("attribution_basis: unknown_transcript_speakers");
    // The collector's synthetic transcript message belongs to the uploader;
    // it must never become speaker-author metadata in the raw transcript.
    expect(staged).not.toContain("Message metadata:");
    expect(staged).not.toContain("author_actor_id");
    expect(mocks.model).not.toHaveBeenCalled();
    const sources = await listRawSourcesForAgent(
      agentWorkspaceRoot(root, "agent_1"),
      "agent_1",
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceUri).toBe(
      "teamhub://documents/document_capture_1/versions/version_revised",
    );
    expect(
      await readRawSource(agentWorkspaceRoot(root, "agent_1"), sources[0]!),
    ).toBe(text);
  });
  it("hands each staged meeting to Tracking Items at once, from its transcript alone", async () => {
    await runWikiSessionSources(argv());
    expect(mocks.tracking).toHaveBeenCalledExactlyOnceWith(
      "agent_1",
      "2026-09-15",
      [
        {
          path: "agent_1/evidence/2026-09-15/sessions/recordings/capture_1.md",
          content: expect.stringContaining("## Authoritative Raw Evidence"),
        },
      ],
      "meeting",
    );
    // An unchanged version is not staged, so it is not handed over again.
    await runWikiSessionSources(argv());
    expect(mocks.tracking).toHaveBeenCalledOnce();
  });

  it("creates distinct files for two Captures in one Room, and skips unchanged versions", async () => {
    for (const id of ["capture_1", "capture_2"]) {
      mocks.recordings.mockResolvedValue([candidate(id)]);
      expect(await runWikiSessionSources(argv(id))).toEqual({
        updatedSessionCount: 1,
      });
    }
    expect(mocks.daily).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    const sources = await listRawSourcesForAgent(
      agentWorkspaceRoot(root, "agent_1"),
      "agent_1",
    );
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.anchorPath)).toEqual(
      expect.arrayContaining([
        "memory-state/evidence/2026-09-15/sessions/recordings/capture_1.md",
        "memory-state/evidence/2026-09-15/sessions/recordings/capture_2.md",
      ]),
    );
    expect(
      await readRawSource(agentWorkspaceRoot(root, "agent_1"), sources[0]!),
    ).toBe(transcript);
    expect(await runWikiSessionSources(argv("capture_2"))).toEqual({
      updatedSessionCount: 0,
    });
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("reads exact transcript evidence without requiring a graph", async () => {
    await runWikiSessionSources(argv());
    const identity = {
      tenant_id: "tenant_1",
      agent_id: "agent_1",
      agent_actor_id: "actor_agent",
      user_artifact_owner_actor_id: "human_1",
    };
    const database = new RawDatabaseFixture();
    for (const source of await listRawSourcesForAgent(
      agentWorkspaceRoot(root, "agent_1"),
      "agent_1",
    )) {
      const content = await readRawSource(
        agentWorkspaceRoot(root, "agent_1"),
        source,
      );
      if (content !== undefined) database.put(source, content);
    }
    const result = await queryPersonalKnowledge(
      root,
      {
        ...identity,
        query: "Cobalt limit source text",
      },
      { chunkSearch: database },
    );
    const match = result.items.find((value) => value.id.startsWith("raw_"));
    expect(match).toBeDefined();
    const evidence = await readPersonalKnowledgeEvidence(
      root,
      {
        ...identity,
        evidence_id: match!.id,
        section_requests: [
          { section_id: String(match!.metadata!.matchedChunk) },
        ],
      },
      { rawSourceProvider: database },
    );
    expect(
      evidence.sections.map((value) => value.content).join("\n"),
    ).toContain("37.5");
  });

  it("retains exact version-linked Raw after the recording leaves the Session graph window", async () => {
    await runWikiSessionSources(argv());
    const project = memoryFilePath(
      root,
      "agent_1",
      "knowledge/projects/cobalt.md",
    );
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(
      project,
      "---\ntype: Project Memory\ntitle: Cobalt\nproject_name: Cobalt\nproject_slug: cobalt\nmemory_subject_key: agent_1\nsources:\n  - resource: teamhub://documents/document_capture_1/versions/version_capture_1\n---\n# Cobalt\n\n## Project Summary\n\nActive project.\n",
    );
    await expect(
      fs.access(path.join(root, "agent_1/memory/subject-graph.json")),
    ).rejects.toThrow();
  });

  it("rejects unreadable or corrupt transcript versions without advancing checkpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad")),
    );
    await expect(
      collectRecordingSession(options(), subject, candidate()),
    ).rejects.toThrow("integrity");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(
      collectRecordingSession(options(), subject, candidate()),
    ).rejects.toThrow("403");
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("never treats authorization Room members as recording evidence", () => {
    expect(() =>
      recordingCollection(
        options(),
        subject,
        { ...candidate(), tenantId: "other" },
        transcript,
      ),
    ).toThrow("scope");
    expect(() =>
      recordingCollection(
        options(),
        subject,
        { ...candidate(), agentIsMember: false, humanIsMember: false },
        transcript,
      ),
    ).toThrow("scope");
    const value = recordingCollection(
      options(),
      subject,
      candidate(),
      transcript,
    );
    expect(value.recording?.captureId).toBe("capture_1");
    expect(value.rooms[0]!.messages).toHaveLength(1);
  });
});

describe("recorder's private questions and requests", () => {
  const rows = {
    recordingStartOffsetMs: 60_000,
    questions: [
      {
        kind: "answer",
        task_sent: false,
        question: "What was the budget?",
        answer: "37.5k USD",
        answered: true,
        cutoff_offset_ms: 180_000,
      },
      {
        kind: "answer",
        task_sent: false,
        question: "Who owns QA?",
        answer: "",
        answered: false,
        cutoff_offset_ms: 240_000,
      },
      {
        kind: "task",
        task_sent: true,
        question: "Draft the launch\nemail to Lena",
        answer: "",
        answered: true,
        cutoff_offset_ms: 300_000,
      },
      {
        kind: "task",
        task_sent: false,
        question: "Remind me about QA",
        answer: "",
        answered: true,
        cutoff_offset_ms: 310_000,
      },
    ],
  };

  it("renders labeled sections on recording time", () => {
    expect(renderRecordingPrivateContext(rows)).toBe(
      [
        "## Questions asked during the meeting",
        "",
        "- Q: What was the budget?",
        "  A: 37.5k USD (based on the recording up to 02:00)",
        "- Q: Who owns QA?",
        "  A (not answered): None. (based on the recording up to 03:00)",
        "",
        "## Requests the recorder gave Another Me during the meeting",
        "",
        "- [04:00] Draft the launch email to Lena (sent to Another Me)",
        "- [04:10] Remind me about QA (not sent)",
        "",
      ].join("\n"),
    );
  });

  it("omits empty sections and returns nothing without private data", () => {
    const onlyRequests = renderRecordingPrivateContext({
      ...rows,
      questions: rows.questions.filter((item) => item.kind === "task"),
    });
    expect(onlyRequests).toContain("## Requests the recorder gave Another Me");
    expect(onlyRequests).not.toContain("## Questions");
    expect(
      renderRecordingPrivateContext({
        recordingStartOffsetMs: 0,
        questions: [],
      }),
    ).toBeUndefined();
  });

  it("changes the source version only when the rendered private context changes", () => {
    const base = candidate();
    const plain = recordingSourceVersion(base);
    expect(plain).toBe(`${base.documentVersionId}:${base.sha256}`);
    const withPrivate = recordingSourceVersion({
      ...base,
      privateContext: renderRecordingPrivateContext(rows),
    });
    expect(withPrivate).toBe(
      recordingSourceVersion({
        ...base,
        privateContext: renderRecordingPrivateContext(structuredClone(rows)),
      }),
    );
    expect(withPrivate).not.toBe(plain);
    for (const changed of [
      {
        ...rows,
        questions: rows.questions.map((item, index) =>
          index === 3 ? { ...item, task_sent: true } : item,
        ),
      },
      { ...rows, questions: rows.questions.slice(1) },
    ])
      expect(
        recordingSourceVersion({
          ...base,
          privateContext: renderRecordingPrivateContext(changed),
        }),
      ).not.toBe(withPrivate);
    expect(
      sourceVersionCoversTranscript(
        withPrivate,
        base.documentVersionId,
        base.sha256,
      ),
    ).toBe(true);
    expect(
      sourceVersionCoversTranscript(plain, base.documentVersionId, base.sha256),
    ).toBe(true);
    expect(
      sourceVersionCoversTranscript(withPrivate, "version_other", base.sha256),
    ).toBe(false);
  });

  it("stages the private sections after the transcript in Session Evidence and Raw, and re-stages on change", async () => {
    const privateContext = renderRecordingPrivateContext(rows)!;
    mocks.recordings.mockResolvedValue([{ ...candidate(), privateContext }]);
    const wikiArgv = argv();
    await runWikiSessionSources(wikiArgv);
    const evidence = await fs.readFile(
      memoryFilePath(
        root,
        "agent_1",
        "evidence/2026-09-15/sessions/recordings/capture_1.md",
      ),
      "utf8",
    );
    expect(evidence).toContain(
      "resource: teamhub://documents/document_capture_1/versions/version_capture_1",
    );
    expect(evidence.indexOf("The Cobalt limit")).toBeLessThan(
      evidence.indexOf("## Questions asked during the meeting"),
    );
    const [source] = await listRawSourcesForAgent(
      agentWorkspaceRoot(root, "agent_1"),
      "agent_1",
    );
    expect(
      await readRawSource(agentWorkspaceRoot(root, "agent_1"), source!),
    ).toBe(`${transcript.trimEnd()}\n\n${privateContext}`);
    const checkpoint = await readSessionlyCheckpoint(root, {
      date: "2026-09-15",
      memorySubjectKey: "agent_1",
      roomId: "room_1",
      recordingId: "capture_1",
    });
    expect(checkpoint?.sourceVersion).toBe(
      recordingSourceVersion({ ...candidate(), privateContext }),
    );
    const fetchCalls = vi.mocked(fetch).mock.calls.length;
    await runWikiSessionSources(wikiArgv);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCalls);
    const updated = renderRecordingPrivateContext({ ...rows, questions: [] })!;
    mocks.recordings.mockResolvedValue([
      { ...candidate(), privateContext: updated },
    ]);
    await runWikiSessionSources(wikiArgv);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCalls + 1);
    const [restaged] = await listRawSourcesForAgent(
      agentWorkspaceRoot(root, "agent_1"),
      "agent_1",
    );
    expect(
      await readRawSource(agentWorkspaceRoot(root, "agent_1"), restaged!),
    ).not.toContain("## Questions asked during the meeting");
  });
});
