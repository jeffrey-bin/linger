vi.mock("../../src/memory/teamhub-wiki.js", () => ({
  teamHubWikiAccess: () => ({}),
  readPublishedWiki: async () => ({
    isCurrent: true,
    revision: "revision",
    pages: [
      {
        path: "sessions/2026-10-17/room_1.md",
        documentId: "doc",
        documentVersionId: "version",
      },
    ],
  }),
  downloadPublishedWikiPage: async () =>
    new TextEncoder().encode("# Published Summary\n"),
}));
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMemoryRoot } from "../../src/memory/paths.js";

vi.mock("../../src/memory/collector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: async () =>
    ["agent_a", "agent_b"].map((memorySubjectKey) => ({ memorySubjectKey })),
}));
vi.mock("../../src/memory/pocket-note-source.js", () => ({
  stagePocketNote: async () => false,
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("runDailyCli", () => {
  it("keeps running other subjects when one subject fails", async () => {
    const { runDailyCli } = await import("../../src/memory/daily-cli.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-isolation-"));
    roots.push(root);
    const date = "2026-10-17";
    for (const subject of ["agent_a", "agent_b"]) {
      const sessions = path.join(
        root,
        subject,
        "memory-state",
        "evidence",
        date,
        "sessions",
      );
      await fs.mkdir(sessions, { recursive: true });
      await fs.writeFile(path.join(sessions, "room_1.md"), "# Session\n");
    }
    // agent_a's previous Daily is unreadable (a directory), so only its
    // collection fails; this holds even when tests run as root.
    await fs.mkdir(
      path.join(
        agentMemoryRoot(root, "agent_a"),
        "timeline",
        "daily",
        "2026-10-16.md",
      ),
      { recursive: true },
    );

    await expect(
      runDailyCli(["collect", "--date", date, "--memory-root", root]),
    ).rejects.toThrow(/1 of 2 Daily subjects failed: agent_a:/u);
    await expect(
      fs.stat(
        path.join(root, "updates", "daily", date, "agent_b", "collection.json"),
      ),
    ).resolves.toBeTruthy();
  });
});
