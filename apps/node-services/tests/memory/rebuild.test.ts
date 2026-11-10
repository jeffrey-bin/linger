import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveMemorySubjectState,
  runRebuildStep,
} from "../../src/memory/rebuild.js";
import { rebuildRequest } from "../../src/memory/rebuild-cli.js";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("rebuild state archive", () => {
  it("moves only the subject's derived state and keeps shared service state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-rebuild-"));
    roots.push(root);
    const files = [
      "agent_a/memory-state/evidence/2026-09-26/sessions/.checkpoints/room_1.json",
      "agent_a/llm-wiki/index.md",
      "updates/sessionly/2026-09-26/agent_a/collection.json",
      "updates/daily/2026-09-26/agent_a/daily.llm-output.json",
      "updates/daily/2026-09-26/agent_b/daily.llm-output.json",
      "updates/task-state/wiki-pending/2026-09-26/agent_a.json",
      "updates/chunk-agent-locks/agent_a",
      // Rebuild Wiki receipts are per subject; the calendar's stays shared.
      "updates/wiki-sync/2026-09-26/agent_a/result.json",
      "updates/wiki-sync/2026-09-26/result.json",
    ];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), "{}");
    }
    const archive = await archiveMemorySubjectState(
      root,
      "agent_a",
      new Date("2026-09-30T02:00:00.000Z"),
    );
    expect(path.relative(root, archive)).toBe(
      "agent_a/memory.pre-rebuild-2026-09-30T02-00-00-000Z",
    );
    const exists = (file: string) =>
      fs.access(path.join(root, file)).then(
        () => true,
        () => false,
      );
    expect(await Promise.all(files.map((file) => exists(file)))).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    const moved = path.relative(root, archive);
    expect(
      await exists(
        `${moved}/.state/evidence/2026-09-26/sessions/.checkpoints/room_1.json`,
      ),
    ).toBe(true);
    expect(
      await exists(
        `${moved}/.updates/task-state/wiki-pending/2026-09-26/agent_a.json`,
      ),
    ).toBe(true);
    expect(
      await exists(
        `${moved}/.updates/daily/2026-09-26/agent_a/daily.llm-output.json`,
      ),
    ).toBe(true);
  });
});

describe("rebuild CLI", () => {
  it("maps operator commands to the local rebuild API", () => {
    expect(rebuildRequest(["start", "--owner", "human_a"])).toEqual({
      method: "POST",
      path: "/internal/v1/rebuild",
      body: { owner_actor_id: "human_a" },
    });
    expect(
      rebuildRequest([
        "start",
        "--subject",
        "agent_a",
        "--from",
        "2026-09-23",
        "--restart",
      ]).body,
    ).toEqual({
      memory_subject_key: "agent_a",
      from: "2026-09-23",
      restart: true,
    });
    expect(rebuildRequest(["status", "--owner", "human_a"])).toEqual({
      method: "GET",
      path: "/internal/v1/rebuild?owner_actor_id=human_a",
    });
    for (const invalid of [
      ["start", "--owner", "human_a", "--to", "2026-09-30"],
      ["status", "--owner", "human_a", "--subject", "agent_a"],
      ["status", "--owner", "human_a", "--from", "2026-01-01"],
      ["status"],
      ["reset", "--owner", "human_a"],
      ["status", "--owner", "human_a", "--unknown"],
    ]) {
      expect(() => rebuildRequest(invalid)).toThrow();
    }
  });
});

describe("rebuild steps", () => {
  const subject = {
    tenantId: "tenant_a",
    agentActorId: "actor_a",
    agentManagementId: "agent_a",
    memorySubjectKey: "agent_a",
    representedHumanActorId: "human_a",
  };
  const wiki = (current: boolean) => ({
    wiki_revision_id: "revision_1",
    published_at: "2026-09-30T00:00:00Z",
    is_current: current,
    wiki_state: "clean",
    pages: [
      {
        page_key: "index.md",
        document_id: "document_1",
        document_version_id: "version_1",
        media_type: "text/markdown",
        sha256: "a".repeat(64),
        size_bytes: 1,
      },
    ],
  });
  const step = (task: "init" | "index-initial" | "index-final") => ({
    task,
    date: "2026-09-30",
    concurrency: 1,
    memorySubjectKey: "agent_a",
  });

  it("initializes the Wiki over the current sources and waits until TeamHub is already latest", async () => {
    const requested: { url: string; body: unknown }[] = [];
    const statuses = ["accepted", "already_latest"];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === "POST") {
        requested.push({
          url: requestUrlText(url),
          body: JSON.parse(requestBodyText(init.body)),
        });
        return Response.json({
          refresh_status: statuses.shift(),
          wiki_id: "wiki_1",
        });
      }
      return Response.json(wiki(true));
    });
    await runRebuildStep(step("init"), {
      access: { baseUrl: "http://teamhub.test", token: "test", fetch },
      loadSubjects: async () => [subject],
      pollMs: 1,
    });
    expect(requested).toEqual(
      Array.from({ length: 2 }, () => ({
        url: `http://teamhub.test/v0/personal-wikis/${subject.representedHumanActorId}/memory-refresh`,
        body: { date: "2026-09-30", tenant_id: "tenant_a" },
      })),
    );
    expect(statuses).toEqual([]);
  });

  it("indexes Raw and the requested OpenWiki collections", async () => {
    const indexes = {
      raw: {
        syncAgent: vi.fn(async () => ({ indexed: 1, retired: 0, skipped: 0 })),
      },
      wiki: { indexOwner: vi.fn(async () => {}) },
    };
    const dependencies = {
      ...indexes,
      access: { baseUrl: "http://teamhub.test", token: "test" },
      loadSubjects: async () => [subject],
      pollMs: 1,
    };
    await runRebuildStep(step("index-initial"), dependencies);
    await runRebuildStep(step("index-final"), dependencies);
    expect(indexes.raw.syncAgent.mock.calls).toEqual([
      ["agent_a"],
      ["agent_a"],
    ]);
    expect(indexes.wiki.indexOwner.mock.calls).toEqual([
      [subject, ["wiki"]],
      [subject, ["wiki", "daily", "weekly"]],
    ]);
  });
});
