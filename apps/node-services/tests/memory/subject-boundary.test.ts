vi.mock("../../src/memory/teamhub-wiki.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/teamhub-wiki.js")>()),
  teamHubWikiAccess: () => ({}),
  readPublishedWiki: async () => undefined,
}));
vi.mock("../../src/memory/pocket-note-source.js", () => ({
  stagePocketNote: async () => false,
}));
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AnotherMeSubject,
  DailyCollection,
  WeeklyCollection,
} from "../../src/memory/types.js";

const collectDaily = vi.hoisted(() => vi.fn());
const loadAnotherMeSubjects = vi.hoisted(() => vi.fn());
const generateUpdate = vi.hoisted(() => vi.fn());
const runValidatedMemoryModelUpdate = vi.hoisted(() => vi.fn());
const syncWeeklyMemory = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/memory/collector.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/memory/collector.js")>(
    "../../src/memory/collector.js",
  )),
  collectDaily,
  loadAnotherMeSubjects,
}));

vi.mock("../../src/memory/llm.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/memory/llm.js")>(
    "../../src/memory/llm.js",
  )),
  runValidatedMemoryModelUpdate,
}));

vi.mock("../../src/memory/user-memory-sync.js", () => ({
  syncWeeklyMemory,
}));

import { runDailyCli } from "../../src/memory/daily-cli.js";
import { ensureMemoryScaffold } from "../../src/memory/scaffold.js";
import { readSessionlyCheckpoint } from "../../src/memory/sessionly-checkpoint.js";
import {
  runWeeklyCli,
  runWikiSessionSources,
} from "../../src/memory/sync-runners.js";
import {
  listRawSourcesForAgent,
  readRawSource,
} from "../../src/memory/search/source-store.js";
import { agentWorkspaceRoot } from "../../src/memory/paths.js";

const roots: string[] = [];
const date = "2026-09-02";
const subject: AnotherMeSubject = {
  tenantId: "tenant_acme",
  agentActorId: "actor_anotherme_alice",
  agentManagementId: "agent_anotherme_alice",
  agentDisplayName: "Alice's Another Me",
  representedHumanActorId: "actor_alice",
  representedHumanDisplayName: "Alice",
  representedHumanAccountId: "account_alice",
  memorySubjectKey: "agent_anotherme_alice",
};

beforeEach(() => {
  collectDaily.mockReset();
  loadAnotherMeSubjects.mockReset();
  loadAnotherMeSubjects.mockResolvedValue([subject]);
  generateUpdate.mockReset();
  runValidatedMemoryModelUpdate.mockReset();
  runValidatedMemoryModelUpdate.mockImplementation(
    async (
      options: unknown,
      artifacts: { outputPath: string },
      validate: (outputPath: string) => Promise<void>,
    ) => {
      const outputPath = await generateUpdate(options, artifacts);
      await validate(outputPath);
      return outputPath;
    },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("AnotherMe memory subject boundary", () => {
  it("scaffolds only explicitly supplied AnotherMe subjects", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    const ordinaryMemory = path.join(memoryRoot, "agent_general", "memory");
    await fs.mkdir(ordinaryMemory, { recursive: true });
    await fs.writeFile(path.join(ordinaryMemory, "keep.md"), "# Existing\n");

    await ensureMemoryScaffold(memoryRoot, [subject]);

    await expect(
      fs.readFile(
        path.join(memoryRoot, subject.memorySubjectKey, "memory", "README.md"),
        "utf8",
      ),
    ).resolves.toContain("timeline/");
    await expect(fs.readdir(ordinaryMemory)).resolves.toEqual(["keep.md"]);
    await expect(
      fs.access(path.join(memoryRoot, "anotherme-alice")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("projects the canonical user profile and clears stale content when absent", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    const represented = {
      ...subject,
      userProfileRevisionId: "representation_profile_revision_1",
      userProfileMarkdown:
        "## Identity And Trajectory\n\nBuilds evidence-led products.",
    };

    await ensureMemoryScaffold(memoryRoot, [represented]);

    const content = await fs.readFile(
      path.join(
        memoryRoot,
        subject.memorySubjectKey,
        "memory",
        "me",
        "profile.md",
      ),
      "utf8",
    );
    expect(content).toContain("status: stable");
    expect(content).toContain(
      'source_revision_id: "representation_profile_revision_1"',
    );
    expect(content).toContain("Builds evidence-led products.");
    const profilePath = path.join(
      memoryRoot,
      subject.memorySubjectKey,
      "memory/me/profile.md",
    );
    const sentinelTime = new Date("2026-01-01T00:00:00Z");
    await fs.utimes(profilePath, sentinelTime, sentinelTime);
    await ensureMemoryScaffold(memoryRoot, [represented]);
    expect((await fs.stat(profilePath)).mtimeMs).toBe(sentinelTime.getTime());
    // Missing canonical content must clear the former stable projection.
    await ensureMemoryScaffold(memoryRoot, [subject]);
    expect(await fs.readFile(profilePath, "utf8")).toContain("status: draft");
    await ensureMemoryScaffold(memoryRoot, [
      {
        ...represented,
        userProfileRevisionId: "representation_profile_revision_2",
        userProfileMarkdown:
          "## Identity And Trajectory\n\nExplicit Add source update.",
      },
    ]);
    expect(await fs.readFile(profilePath, "utf8")).toContain(
      "Explicit Add source update.",
    );
  });

  it("skips an empty scheduled Wiki source batch without calling the model", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    collectDaily.mockResolvedValue({
      ...sessionlyCollectionFixture(memoryRoot, new Map()),
      subjects: [subject],
    });

    await expect(
      runWikiSessionSources([
        "run",
        "--date",
        date,
        "--memory-root",
        memoryRoot,
      ]),
    ).resolves.toEqual({ updatedSessionCount: 0 });
    expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
  });

  it("still rejects a requested Room that does not match the collection", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    collectDaily.mockResolvedValue(
      sessionlyCollectionFixture(
        memoryRoot,
        new Map([["room_allowed", subject]]),
      ),
    );

    await expect(
      runWikiSessionSources([
        "run",
        "--date",
        date,
        "--memory-root",
        memoryRoot,
        "--room-id",
        "room_missing",
      ]),
    ).rejects.toThrow("No session rooms matched the supplied options");
    expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
  });

  it("does not treat a failed Wiki source collection as empty input", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    collectDaily.mockRejectedValueOnce(
      new Error("Attachment storage unavailable"),
    );

    await expect(
      runWikiSessionSources([
        "run",
        "--date",
        date,
        "--memory-root",
        memoryRoot,
      ]),
    ).rejects.toThrow("Attachment storage unavailable");
    expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
  });

  it("restages complete Room Raw only when new messages arrive", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    const roomId = "room_a1";
    const fixture = sessionlyCollectionFixture(
      memoryRoot,
      new Map([[roomId, subject]]),
    );
    const originalBody = "The initial launch plan was approved.";
    fixture.rooms[0]!.messages[0]!.body = originalBody;
    collectDaily.mockResolvedValue(fixture);
    const argv = ["run", "--date", date, "--memory-root", memoryRoot];

    await expect(runWikiSessionSources(argv)).resolves.toEqual({
      updatedSessionCount: 1,
    });
    await expect(runWikiSessionSources(argv)).resolves.toEqual({
      updatedSessionCount: 0,
    });

    fixture.rooms[0]!.messages.push({
      ...fixture.rooms[0]!.messages[0]!,
      id: "message_room_a1_second",
      body: "A later correction from the Room.",
      createdAt: `${date}T09:00:00.000Z`,
    });
    await expect(runWikiSessionSources(argv)).resolves.toEqual({
      updatedSessionCount: 1,
    });

    // The Wiki reads this Session Raw once it is indexed.
    const workspace = agentWorkspaceRoot(memoryRoot, subject.agentManagementId);
    const sources = await listRawSourcesForAgent(
      workspace,
      subject.agentManagementId,
    );
    expect(sources).toHaveLength(1);
    const raw = await readRawSource(workspace, sources[0]!);
    expect(raw).toContain(originalBody);
    expect(raw).toContain("A later correction from the Room.");
    await expect(
      readSessionlyCheckpoint(memoryRoot, {
        date,
        memorySubjectKey: subject.memorySubjectKey,
        roomId,
      }),
    ).resolves.toMatchObject({
      lastMessage: {
        messageId: "message_room_a1_second",
        createdAt: `${date}T09:00:00.000Z`,
      },
    });
    expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
  });

  it.each(["missing", "empty"])(
    "skips Daily with a %s session directory",
    async (kind) => {
      const memoryRoot = await temporaryMemoryRoot();
      if (kind === "empty") {
        await fs.mkdir(
          path.join(
            memoryRoot,
            subject.memorySubjectKey,
            "memory-state",
            "evidence",
            date,
            "sessions",
          ),
          { recursive: true },
        );
      }

      await expect(
        runDailyCli(["run", "--date", date, "--memory-root", memoryRoot]),
      ).resolves.toEqual({ processedSubjectCount: 0 });
      expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
    },
  );

  it("does not treat Daily filesystem permission errors as empty input", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    await writeSession(memoryRoot, subject.memorySubjectKey, "room_allowed");
    const error = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);

    await expect(
      runDailyCli(["run", "--date", date, "--memory-root", memoryRoot]),
    ).rejects.toThrow("Permission denied");
    expect(runValidatedMemoryModelUpdate).not.toHaveBeenCalled();
  });

  it("runs isolated weekly generations with bounded concurrency", async () => {
    const memoryRoot = await temporaryMemoryRoot();
    const subjects = [
      subject,
      anotherMeSubject("bob"),
      anotherMeSubject("mallory"),
    ];
    loadAnotherMeSubjects.mockResolvedValue(subjects);
    for (const currentSubject of subjects) {
      const directory = path.join(
        memoryRoot,
        currentSubject.memorySubjectKey,
        "memory",
        "timeline",
        "daily",
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, `${date}.md`),
        `## Daily Work\n\n- PRIVATE_MARKER_${currentSubject.memorySubjectKey}\n`,
      );
    }

    let activeGenerations = 0;
    let maxActiveGenerations = 0;
    generateUpdate.mockImplementation(
      async (
        _options: unknown,
        artifacts: { promptPath: string; outputPath: string },
      ) => {
        const memorySubjectKey = path.basename(
          path.dirname(artifacts.outputPath),
        );
        const currentSubject = subjects.find(
          (candidate) => candidate.memorySubjectKey === memorySubjectKey,
        );
        if (!currentSubject) {
          throw new Error(`Unexpected weekly subject: ${memorySubjectKey}`);
        }
        const prompt = await fs.readFile(artifacts.promptPath, "utf8");
        expect(prompt).toContain("week starting 2026-08-31");
        expect(prompt).not.toContain("{{weekStart}}");
        for (const candidate of subjects) {
          expect(
            prompt.includes(`PRIVATE_MARKER_${candidate.memorySubjectKey}`),
          ).toBe(candidate === currentSubject);
          if (candidate !== currentSubject) {
            expect(prompt).not.toContain(candidate.memorySubjectKey);
          }
        }

        activeGenerations += 1;
        maxActiveGenerations = Math.max(
          maxActiveGenerations,
          activeGenerations,
        );
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await fs.writeFile(
            artifacts.outputPath,
            JSON.stringify({
              description: `Week of ${memorySubjectKey}.`,
              source_refs: ["daily_2026-09-02"],
              closed_works: [],
              ongoing_works: [],
              open_works: [],
              big_change: [],
              work_intensity: "One active day.",
              pattern: [],
            }),
          );
        } finally {
          activeGenerations -= 1;
        }
        return artifacts.outputPath;
      },
    );

    await runWeeklyCli([
      "run",
      "--week-start",
      "2026-08-31",
      "--concurrency",
      "2",
      "--memory-root",
      memoryRoot,
    ]);

    expect(generateUpdate).toHaveBeenCalledTimes(3);
    expect(runValidatedMemoryModelUpdate).toHaveBeenCalledTimes(3);
    expect(maxActiveGenerations).toBe(2);
    // Each applied Weekly is then taken into that subject's memory.md.
    for (const currentSubject of subjects)
      expect(syncWeeklyMemory).toHaveBeenCalledWith(
        memoryRoot,
        currentSubject,
        { start: "2026-08-31", end: "2026-09-06" },
      );
    for (const currentSubject of subjects) {
      const collection = await readJson<WeeklyCollection>(
        path.join(
          memoryRoot,
          "updates",
          "weekly",
          "2026-08-31",
          currentSubject.memorySubjectKey,
          "collection.json",
        ),
      );
      expect(collection.memorySubjectKey).toBe(currentSubject.memorySubjectKey);
      expect(
        collection.existingMemoryFiles.every(({ path: filePath }) =>
          filePath.startsWith(`${currentSubject.memorySubjectKey}/`),
        ),
      ).toBe(true);
      await expect(
        fs.readFile(
          path.join(
            memoryRoot,
            currentSubject.memorySubjectKey,
            "memory",
            "timeline",
            "weekly",
            "2026-08-31.md",
          ),
          "utf8",
        ),
      ).resolves.toContain(currentSubject.memorySubjectKey);
    }
  });
});

async function temporaryMemoryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-subjects-"));
  roots.push(root);
  return root;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function sessionlyCollectionFixture(
  memoryRoot: string,
  roomSubjects: ReadonlyMap<string, AnotherMeSubject>,
): DailyCollection {
  const createdAt = `${date}T08:00:00.000Z`;
  return {
    schemaVersion: 1,
    date,
    timeZone: "Asia/Shanghai",
    generatedAt: createdAt,
    source: {
      teamhubDatabaseUrlSet: true,
      memoryRoot,
    },
    subjects: [...new Set(roomSubjects.values())],
    rooms: [...roomSubjects].map(([roomId, roomSubject]) => ({
      tenantId: roomSubject.tenantId,
      roomId,
      roomName: roomId,
      agentActorId: roomSubject.agentActorId,
      agentManagementId: roomSubject.agentManagementId,
      representedHumanActorId: roomSubject.representedHumanActorId,
      memorySubjectKey: roomSubject.memorySubjectKey,
      relation: {
        agentIsMember: false,
        representedHumanIsMember: true,
        agentIsCreator: false,
        representedHumanIsCreator: true,
        includedBecause: ["represented_human_member"],
      },
      messages: [
        {
          id: `message_${roomId}`,
          roomId,
          authorActorId: roomSubject.representedHumanActorId,
          authorDisplayName: roomSubject.representedHumanDisplayName,
          authorKind: "human",
          messageKind: "conversation",
          body: `Message in ${roomId}`,
          createdAt,
          attachments: [],
        },
      ],
    })),
    existingMemoryFiles: [],
  };
}

function anotherMeSubject(name: string): AnotherMeSubject {
  return {
    ...subject,
    agentActorId: `actor_anotherme_${name}`,
    agentManagementId: `agent_anotherme_${name}`,
    agentDisplayName: `${name}'s Another Me`,
    representedHumanActorId: `actor_${name}`,
    representedHumanDisplayName: name,
    representedHumanAccountId: `account_${name}`,
    memorySubjectKey: `agent_anotherme_${name}`,
  };
}

async function writeSession(
  memoryRoot: string,
  subjectKey: string,
  roomId: string,
): Promise<void> {
  const directory = path.join(
    memoryRoot,
    subjectKey,
    "memory-state",
    "evidence",
    date,
    "sessions",
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${roomId}.md`),
    `---\ntype: Session Memory\ndate: ${date}\nroom_id: ${roomId}\nmemory_subject_key: ${subjectKey}\n---\n\n# Session: ${roomId}\n\n## CRM Evidence Cache\n\nNone observed.\n`,
  );
}
