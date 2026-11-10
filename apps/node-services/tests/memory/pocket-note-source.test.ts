import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentWorkspaceRoot } from "../../src/memory/paths.js";
import { stagePocketNote } from "../../src/memory/pocket-note-source.js";
import { listRawSourcesForAgent } from "../../src/memory/search/source-store.js";

const date = "2026-10-01";
const subject = {
  agentManagementId: "agent_alice",
  memorySubjectKey: "agent_alice",
  representedHumanActorId: "actor_alice",
  tenantId: "tenant_acme",
};

describe("Pocket Note Raw source", () => {
  let root: string;
  let anchor: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pocket-note-source-"));
    anchor = path.join(
      root,
      subject.memorySubjectKey,
      "memory-state/evidence",
      date,
      "sessions/pocket-note.md",
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stages the day's note as current Raw evidence", async () => {
    await expect(
      stagePocketNote(root, subject, date, async () => "first draft"),
    ).resolves.toBe(true);
    await expect(
      stagePocketNote(root, subject, date, async () => "  buy milk\n"),
    ).resolves.toBe(true);

    expect(await fs.readFile(anchor, "utf8")).toContain(
      "source_kind: pocket_note",
    );
    const sources = await listRawSourcesForAgent(
      agentWorkspaceRoot(root, subject.agentManagementId),
      subject.agentManagementId,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      date,
      identity: {
        agent_id: "agent_alice",
        tenant_id: "tenant_acme",
        user_artifact_owner_actor_id: "actor_alice",
      },
      originKind: "pocket_note",
      // Not a Room or recording Session, so never a Wiki Session source.
      sourceKind: "pocket_note",
      sourceUri: `teamhub://pocket-notes/${date}`,
    });
    const rawDirectory = path.join(
      root,
      subject.agentManagementId,
      "memory-state/raw/2026/10/01/pocket-note",
    );
    const snapshots = (await fs.readdir(rawDirectory)).filter(
      (name) => name !== "manifest.json",
    );
    expect(snapshots).toHaveLength(1);
    expect(
      await fs.readFile(path.join(rawDirectory, snapshots[0]!), "utf8"),
    ).toBe("buy milk");
  });

  it("withdraws the Session when the page is empty and skips failures", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await stagePocketNote(root, subject, date, async () => "keep me");

    await expect(
      stagePocketNote(root, subject, date, async () => {
        throw new Error("TeamHub database unavailable");
      }),
    ).resolves.toBe(false);
    expect(await fs.readFile(anchor, "utf8")).toContain("keep me");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("memory.pocket_note_skipped"),
    );

    await expect(
      stagePocketNote(root, subject, date, async () => undefined),
    ).resolves.toBe(false);
    await expect(fs.access(anchor)).rejects.toThrow();
    await expect(
      stagePocketNote(root, subject, date, async () => "   "),
    ).resolves.toBe(false);
  });
});
