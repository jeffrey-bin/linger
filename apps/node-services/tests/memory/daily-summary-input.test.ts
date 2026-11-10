import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tracking = vi.hoisted(() => vi.fn(async () => undefined));
const stagedPocketNote = vi.hoisted(() => vi.fn(async () => false));
const readWiki = vi.hoisted(() => vi.fn());
vi.mock("../../src/memory/tracking-items.js", () => ({
  updateDailyTrackingItems: tracking,
}));
vi.mock("../../src/memory/collector.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: async () => [
    {
      memorySubjectKey: "agent_alice",
      representedHumanActorId: "actor_alice",
      representedHumanDisplayName: "Alice",
    },
  ],
}));
vi.mock("../../src/memory/pocket-note-source.js", () => ({
  stagePocketNote: stagedPocketNote,
}));
vi.mock("../../src/memory/teamhub-wiki.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/teamhub-wiki.js")>()),
  readPublishedWiki: readWiki,
}));
import { dailySourceCatalog, runDailyCli } from "../../src/memory/daily-cli.js";
let root: string;
const date = "2026-10-17";
// stagePocketNote writes this frontmatter for every Pocket Note.
const pocketNoteFile = `---\ntype: Session Evidence\ntitle: "${date} Pocket Note"\nsource_kind: pocket_note\n---\n\nPRIVATE NOTE FROM ALICE\n`;
const roomFile = `---\ntype: Session Evidence\ntitle: "Launch room"\ndate: ${date}\nsource_kind: room\nsources:\n  - resource: teamhub://rooms/room_a/messages\n---\n\n# Launch room\n\n## Authoritative Raw Evidence\n\n## 2026-10-17T02:00:00.000Z · Alice\n\nMessage metadata: {"message_id":"m1"}\nWe ship the beta on Friday.\n`;
const recordingFile = `---\ntype: Session Evidence\ntitle: "Recording capture_b"\ndate: ${date}\nsource_kind: meeting\nsources:\n  - resource: teamhub://documents/doc_b/versions/version_b\n---\n\n# Recording capture_b\n\n## Authoritative Raw Evidence\n\nSpeaker 1: The pilot report is due Monday.\n`;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-summary-input-"));
  const dir = path.join(
    root,
    "agent_alice/memory-state/evidence",
    date,
    "sessions",
  );
  await fs.mkdir(path.join(dir, "recordings"), { recursive: true });
  await fs.writeFile(path.join(dir, "room_a.md"), roomFile);
  await fs.writeFile(path.join(dir, "recordings/capture_b.md"), recordingFile);
  await fs.writeFile(path.join(dir, "pocket-note.md"), pocketNoteFile);
});
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const args = () => ["prompt", "--date", date, "--memory-root", root];
const readPrompt = () =>
  fs.readFile(
    path.join(root, "updates/daily", date, "agent_alice/daily.prompt.md"),
    "utf8",
  );
it("reads the day's Raw conversations without waiting for the Wiki", async () => {
  await expect(runDailyCli(args())).resolves.toEqual({
    processedSubjectCount: 1,
  });
  const prompt = await readPrompt();
  expect(prompt).toContain("We ship the beta on Friday.");
  expect(prompt).toContain("The pilot report is due Monday.");
  expect(prompt).not.toContain("Message metadata");
  expect(prompt).not.toContain("PRIVATE NOTE");
  expect(prompt).toContain('"source_ref": "room_a"');
  expect(prompt).toContain('"actorId": "actor_alice"');
  expect(prompt).toContain('"displayName": "Alice"');
  expect(readWiki).not.toHaveBeenCalled();
  // A Room is cited by its id, a recording by its transcript version.
  expect(
    dailySourceCatalog([
      { path: "teamhub://rooms/room_a/messages", content: roomFile },
      {
        path: "teamhub://documents/doc_b/versions/version_b",
        content: recordingFile,
      },
    ]),
  ).toEqual([
    {
      resource: "teamhub://rooms/room_a/messages",
      sourceRef: "room_a",
      title: "Launch room",
    },
    {
      resource: "teamhub://documents/doc_b/versions/version_b",
      sourceRef: "version_b",
      title: "Recording capture_b",
    },
  ]);
});
it("adds the day's Pocket Note to the Daily input as its own source", async () => {
  stagedPocketNote.mockResolvedValueOnce(true);
  await expect(runDailyCli(args())).resolves.toEqual({
    processedSubjectCount: 1,
  });
  const prompt = await readPrompt();
  expect(prompt).toContain("PRIVATE NOTE FROM ALICE");
  expect(prompt).toContain('"source_ref": "pocket-note"');
  expect(prompt).toContain("We ship the beta on Friday.");
  const schema = await fs.readFile(
    path.join(root, "updates/daily", date, "agent_alice/daily.schema.json"),
    "utf8",
  );
  expect(schema).toContain('"pocket-note"');
  const catalog = dailySourceCatalog([
    {
      path: `teamhub://pocket-notes/${date}`,
      content: `---\ntitle: "${date} Pocket Note"\nsource_kind: pocket_note\n---\n`,
    },
  ]);
  // Cited like a Session: by its TeamHub page, never the local staging file.
  expect(catalog).toEqual([
    {
      resource: `teamhub://pocket-notes/${date}`,
      sourceRef: "pocket-note",
      title: `${date} Pocket Note`,
    },
  ]);
});

it("keeps Raw Pocket Note tracking on a day without a conversation or Daily", async () => {
  await fs.rm(
    path.join(
      root,
      "agent_alice/memory-state/evidence",
      date,
      "sessions/room_a.md",
    ),
  );
  await fs.rm(
    path.join(
      root,
      "agent_alice/memory-state/evidence",
      date,
      "sessions/recordings",
    ),
    { recursive: true },
  );
  await expect(
    runDailyCli(["run", "--date", date, "--memory-root", root]),
  ).resolves.toEqual({ processedSubjectCount: 0 });
  expect(tracking).toHaveBeenCalledWith("agent_alice", date, [
    {
      path: `agent_alice/evidence/${date}/sessions/pocket-note.md`,
      content: pocketNoteFile,
    },
  ]);
});
