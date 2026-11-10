import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import { PersonalKnowledgeGraphNotFoundError } from "../../src/memory/graph-visualization.js";
import { MemoryScheduler } from "../../src/memory/scheduler.js";
import { startMemoryServer } from "../../src/memory/server.js";

const roots: string[] = [];
const schedule: MemoryScheduleConfig = {
  concurrency: 1,
  timeZone: "Asia/Shanghai",
  weeklyDay: 1,
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Memory server", () => {
  it("lists and reads only authenticated Memory entries through the internal API", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const listMemoryEntries = vi.fn().mockResolvedValue({
      items: [
        {
          content: "",
          id: "memory_0123456789abcdef01234567",
          kind: "project",

          path: "knowledge/projects/example.md",
          summary: "Example project memory",
          title: "Example",
          updated_at: "2026-09-14T01:02:03.000Z",
        },
      ],
    });
    const getMemoryEntry = vi.fn().mockResolvedValue({
      content: "# Example\n\nProject context.",
      id: "memory_0123456789abcdef01234567",
      kind: "project",

      path: "knowledge/projects/example.md",
      summary: "Example project memory",
      title: "Example",
      updated_at: "2026-09-14T01:02:03.000Z",
    });
    const server = await startMemoryServer({
      dataRoot,
      getMemoryEntry,
      host: "127.0.0.1",
      listMemoryEntries,
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
    });
    try {
      const query =
        "tenant_id=tenant_acme&owner_actor_id=actor_alice&kind=project&limit=10";
      expect(
        await fetch(`${server.url}/internal/v1/memory/entries?${query}`),
      ).toMatchObject({ status: 401 });
      const listResponse = await fetch(
        `${server.url}/internal/v1/memory/entries?${query}`,
        {
          headers: { authorization: "Bearer memory-token" },
        },
      );
      expect(listResponse.status).toBe(200);
      await expect(listResponse.json()).resolves.toMatchObject({
        items: [{ id: "memory_0123456789abcdef01234567", content: "" }],
      });
      expect(listMemoryEntries).toHaveBeenCalledWith({
        dataRoot,
        kind: "project",
        limit: 10,
        ownerActorId: "actor_alice",
        tenantId: "tenant_acme",
      });

      const detailResponse = await fetch(
        `${server.url}/internal/v1/memory/entries/memory_0123456789abcdef01234567?tenant_id=tenant_acme&owner_actor_id=actor_alice`,
        { headers: { authorization: "Bearer memory-token" } },
      );
      expect(detailResponse.status).toBe(200);
      await expect(detailResponse.json()).resolves.toMatchObject({
        content: "# Example\n\nProject context.",
      });
      expect(getMemoryEntry).toHaveBeenCalledWith({
        dataRoot,
        entryId: "memory_0123456789abcdef01234567",
        ownerActorId: "actor_alice",
        tenantId: "tenant_acme",
      });
    } finally {
      await server.close();
    }
  });

  it("serves only the authenticated actor-scoped graph visualization", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const graphVisualization = vi
      .fn()
      .mockResolvedValue("<!doctype html><title>Knowledge Graph</title>");
    const server = await startMemoryServer({
      dataRoot,
      graphVisualization,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
    });
    const body = JSON.stringify({
      owner_actor_id: "actor_alice",
      tenant_id: "tenant_acme",
    });
    try {
      expect(
        await fetch(
          `${server.url}/internal/v1/personal-knowledge-graph-visualization`,
          {
            body,
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      ).toMatchObject({ status: 401 });

      const response = await fetch(
        `${server.url}/internal/v1/personal-knowledge-graph-visualization`,
        {
          body,
          headers: {
            authorization: "Bearer memory-token",
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.text()).resolves.toContain("Knowledge Graph");
      expect(graphVisualization).toHaveBeenCalledWith({
        owner_actor_id: "actor_alice",
        tenant_id: "tenant_acme",
      });
    } finally {
      await server.close();
    }
  });

  it("returns a stable not-found response when the graph has not been generated", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const server = await startMemoryServer({
      dataRoot,
      graphVisualization: vi
        .fn()
        .mockRejectedValue(new PersonalKnowledgeGraphNotFoundError()),
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
    });
    try {
      const response = await fetch(
        `${server.url}/internal/v1/personal-knowledge-graph-visualization`,
        {
          body: JSON.stringify({
            owner_actor_id: "actor_alice",
            tenant_id: "tenant_acme",
          }),
          headers: {
            authorization: "Bearer memory-token",
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "graph_not_found" },
      });
    } finally {
      await server.close();
    }
  });

  it("indexes a published Wiki only from an authenticated callback", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const onWikiPublished = vi.fn().mockResolvedValue(undefined);
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      onWikiPublished,
    });
    const publication = {
      tenant_id: "tenant_a",
      owner_actor_id: "actor_alice",
      wiki_revision_id: "revision_2",
    };
    const post = (body: unknown, authorization = "Bearer memory-token") =>
      fetch(`${server.url}/internal/v1/published-wiki-graph-updates`, {
        body: JSON.stringify(body),
        headers: { authorization, "content-type": "application/json" },
        method: "POST",
      });
    try {
      expect(await post(publication, "")).toMatchObject({ status: 401 });
      expect(await post(publication)).toMatchObject({ status: 204 });
      expect(onWikiPublished).toHaveBeenCalledExactlyOnceWith(publication);
      for (const invalid of [
        { ...publication, tenant_id: undefined },
        { ...publication, request_id: "event_a" },
      ])
        expect(await post(invalid)).toMatchObject({ status: 400 });
      expect(onWikiPublished).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("updates Tracking Items for a changed Pocket Note and reports failures for a retry", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const onPocketNoteChanged = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("model unavailable"));
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      onPocketNoteChanged,
    });
    const change = {
      tenant_id: "tenant_a",
      owner_actor_id: "actor_alice",
      date: "2026-11-06",
    };
    const post = (body: unknown, authorization = "Bearer memory-token") =>
      fetch(`${server.url}/internal/v1/pocket-note-tracking-refreshes`, {
        body: JSON.stringify(body),
        headers: { authorization, "content-type": "application/json" },
        method: "POST",
      });
    try {
      expect(await post(change, "")).toMatchObject({ status: 401 });
      for (const invalid of [
        { ...change, date: "2026-02-30" },
        { ...change, note: "x" },
        { tenant_id: "tenant_a", owner_actor_id: "actor_alice" },
      ])
        expect(await post(invalid)).toMatchObject({ status: 400 });
      expect(onPocketNoteChanged).not.toHaveBeenCalled();
      expect(await post(change)).toMatchObject({ status: 204 });
      expect(onPocketNoteChanged).toHaveBeenCalledWith(change);
      const failed = await post(change);
      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toMatchObject({
        error: { code: "tracking_unavailable" },
      });
    } finally {
      await server.close();
    }
  });

  it("takes a published Profile into memory.md and reports failures for a retry", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const onProfilePublished = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("model unavailable"));
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      onProfilePublished,
    });
    const change = { tenant_id: "tenant_a", owner_actor_id: "actor_alice" };
    const post = (body: unknown, authorization = "Bearer memory-token") =>
      fetch(`${server.url}/internal/v1/profile-memory-syncs`, {
        body: JSON.stringify(body),
        headers: { authorization, "content-type": "application/json" },
        method: "POST",
      });
    try {
      expect(await post(change, "")).toMatchObject({ status: 401 });
      for (const invalid of [
        { tenant_id: "tenant_a" },
        { ...change, revision_id: "personal_profile_revision_a" },
      ])
        expect(await post(invalid)).toMatchObject({ status: 400 });
      expect(onProfilePublished).not.toHaveBeenCalled();
      expect(await post(change)).toMatchObject({ status: 204 });
      expect(onProfilePublished).toHaveBeenCalledWith(change);
      const failed = await post(change);
      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toMatchObject({
        error: { code: "user_memory_unavailable" },
      });
    } finally {
      await server.close();
    }
  });

  it("reports a failed published Wiki index as unavailable so TeamHub retries", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      onWikiPublished: vi
        .fn()
        .mockRejectedValue(new Error("index unavailable")),
    });
    try {
      const response = await fetch(
        `${server.url}/internal/v1/published-wiki-graph-updates`,
        {
          body: JSON.stringify({
            tenant_id: "tenant_a",
            owner_actor_id: "actor_alice",
            wiki_revision_id: "revision_2",
          }),
          headers: {
            authorization: "Bearer memory-token",
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "wiki_index_unavailable" },
      });
    } finally {
      await server.close();
    }
  });

  it("requires its workload credential and serves a Raw Chunk query", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    const received: unknown[] = [];
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      query: async (_root, input) => {
        received.push(input);
        return {
          gaps: [{ code: "no_relevant_evidence" }],
          indexedAt: null,
          items: [],
          schemaVersion: 1 as const,
          status: "empty" as const,
        };
      },
    });
    try {
      const body = {
        agent_actor_id: "actor_agent_1",
        agent_id: "agent_1",
        date_from: "2026-09-01",
        query: "concise answers",
        tenant_id: "tenant_1",
        user_artifact_owner_actor_id: "human_1",
      };
      const post = (payload: unknown, token?: string) =>
        fetch(`${server.url}/internal/v1/query`, {
          body: JSON.stringify(payload),
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
          },
          method: "POST",
        });
      expect(await post(body)).toMatchObject({ status: 401 });
      const response = await post(body, "memory-token");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        status: "empty",
      });
      expect(received).toEqual([body]);
      for (const removed of [
        { source: "personal_knowledge" },
        { node_types: ["Session"] },
      ]) {
        expect(
          await post({ ...body, ...removed }, "memory-token"),
        ).toMatchObject({ status: 400 });
      }
    } finally {
      await server.close();
    }
  });

  it("reads selected personal knowledge evidence through the authorized route", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-server-"));
    roots.push(dataRoot);
    let receivedEvidenceId: string | undefined;
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "memory-token",
      evidenceRead: async (_root, input) => {
        receivedEvidenceId = input.evidence_id;
        return {
          complete: true,
          directory: [{ id: "action_items", level: 2, title: "Action Items" }],
          evidenceId: input.evidence_id,
          missingSections: [],
          schemaVersion: 1 as const,
          sections: [
            {
              content: "## Action Items\n\n- Deliver the first ID proposal.",
              id: "action_items",
              level: 2,
              offset: 0,
              title: "Action Items",
              truncated: false,
            },
          ],
          source: { kind: "raw", ref: input.evidence_id },
          title: "Hardware meeting",
        };
      },
    });
    try {
      const response = await fetch(
        `${server.url}/internal/v1/personal-knowledge/evidence`,
        {
          body: JSON.stringify({
            agent_actor_id: "actor_agent_1",
            agent_id: "agent_1",
            evidence_id: `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
            section_requests: [{ section_id: "action_items" }],
            tenant_id: "tenant_1",
            user_artifact_owner_actor_id: "human_1",
          }),
          headers: {
            authorization: "Bearer memory-token",
            "content-type": "application/json",
          },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(receivedEvidenceId).toBe(
        `raw_${"a".repeat(16)}_${"b".repeat(16)}`,
      );
      await expect(response.json()).resolves.toMatchObject({
        complete: true,
        sections: [
          {
            content: expect.stringContaining("first ID proposal"),
            id: "action_items",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });
});

describe("failure health", () => {
  it("authenticates, degrades each store independently and strictly validates retries", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-failures-"),
    );
    roots.push(dataRoot);
    const scheduler = new MemoryScheduler(schedule, async () => undefined);
    const retryFailed = vi
      .spyOn(scheduler, "retryFailed")
      .mockResolvedValue(["daily:2026-09-29"]);
    const chunkFailures = {
      failedSources: vi.fn().mockRejectedValue(new Error("pg down")),
    };
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler,
      serviceToken: "test",
      chunkFailures,
    });
    const headers = {
      authorization: "Bearer test",
      "content-type": "application/json",
    };
    const retry = (body: unknown, auth = headers) =>
      fetch(`${server.url}/internal/v1/health/failures:retry`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
    try {
      expect(
        (await fetch(`${server.url}/internal/v1/health/failures`)).status,
      ).toBe(401);
      expect((await retry({}, { ...headers, authorization: "" })).status).toBe(
        401,
      );
      const summary = await fetch(`${server.url}/internal/v1/health/failures`, {
        headers,
      });
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual({
        scheduler: {
          exhausted_total: 0,
          exhausted: [],
          pending_retries_total: 0,
          pending_retries: [],
        },
        raw_chunk_sources: { error: "unavailable" },
      });
      for (const invalid of [
        { extra: {} },
        { scheduler: { task_keys: [], extra: true } },
        { scheduler: { task_keys: ["../daily"] } },
        { scheduler: { task_keys: ["init:rebuild:agent_a:2026-09-30"] } },
        { scheduler: { task_keys: [] } },
        { openwiki_jobs: { owner_id: "owner_a" } },
        [],
      ]) {
        expect((await retry(invalid)).status).toBe(400);
      }
      expect(retryFailed).not.toHaveBeenCalled();
      const revived = await retry({
        scheduler: {
          task_keys: ["wiki:2026-09-30T00", "index-initial:rebuild:agent_a"],
        },
      });
      expect(revived.status).toBe(200);
      expect(await revived.json()).toEqual({
        scheduler: { revived: 1, task_keys: ["daily:2026-09-29"] },
      });
      expect(retryFailed).toHaveBeenCalledWith([
        "wiki:2026-09-30T00",
        "index-initial:rebuild:agent_a",
      ]);
    } finally {
      await server.close();
    }
  });

  it("authenticates rebuild requests, strictly validates them and resolves one subject", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-rebuild-"),
    );
    roots.push(dataRoot);
    const scheduler = new MemoryScheduler(schedule, async () => undefined);
    const enqueueRebuild = vi
      .spyOn(scheduler, "enqueueRebuild")
      .mockImplementation(async (_input, prepare) => {
        await prepare?.();
        return { task_keys: ["init:rebuild:agent_a"], queued: [] };
      });
    const rebuildStatus = vi
      .spyOn(scheduler, "rebuildStatus")
      .mockReturnValue({ total: 1 } as ReturnType<
        MemoryScheduler["rebuildStatus"]
      >);
    await fs.mkdir(path.join(dataRoot, "agent_a", "memory"), {
      recursive: true,
    });
    const subject = (memorySubjectKey: string, human: string) => ({
      tenantId: "tenant_a",
      agentActorId: `actor_${memorySubjectKey}`,
      agentManagementId: memorySubjectKey,
      memorySubjectKey,
      representedHumanActorId: human,
    });
    const sessionDates = vi.fn(async () => ["2026-09-26", "2026-09-28"]);
    const clearRebuildIndexes = vi.fn(async () => {});
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler,
      serviceToken: "test",
      rebuildSubjects: async () => [
        subject("agent_a", "human_a"),
        subject("agent_b", "human_b"),
      ],
      rebuildSessionDates: sessionDates,
      clearRebuildIndexes,
    });
    const headers = {
      authorization: "Bearer test",
      "content-type": "application/json",
    };
    const start = (body: unknown, auth = headers) =>
      fetch(`${server.url}/internal/v1/rebuild`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
    try {
      expect(
        (
          await start(
            { memory_subject_key: "agent_a" },
            {
              ...headers,
              authorization: "Bearer wrong",
            },
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(
            `${server.url}/internal/v1/rebuild?owner_actor_id=human_a`,
          )
        ).status,
      ).toBe(401);
      for (const invalid of [
        {},
        { memory_subject_key: "agent_a", owner_actor_id: "human_a" },
        // The end is always today; only a pilot start may be given.
        { memory_subject_key: "agent_a", to: "2026-09-30" },
        { memory_subject_key: "agent_a", extra: true },
        { memory_subject_key: "agent_a", restart: "yes" },
        { memory_subject_key: "../agent" },
        { memory_subject_key: "agent_a", from: "2026-02-30" },
        [],
      ]) {
        expect((await start(invalid)).status).toBe(400);
      }
      const missing = await start({ owner_actor_id: "human_x" });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error.code).toBe("subject_not_found");
      expect(enqueueRebuild).not.toHaveBeenCalled();

      const accepted = await start({
        owner_actor_id: "human_a",
        from: "2026-09-27",
      });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({
        memory_subject_key: "agent_a",
        count: 1,
        queued_count: 0,
        task_keys: ["init:rebuild:agent_a"],
        queued: [],
      });
      expect(sessionDates).toHaveBeenCalledWith(subject("agent_a", "human_a"));
      expect(enqueueRebuild).toHaveBeenCalledWith(
        {
          memorySubjectKey: "agent_a",
          sessionDates: ["2026-09-26", "2026-09-28"],
          from: "2026-09-27",
          restart: undefined,
        },
        expect.any(Function),
      );
      // The first rebuild archives derived state and clears only this owner's
      // index; the archive bumps the Agent's memory revision marker.
      const entries = await fs.readdir(path.join(dataRoot, "agent_a"));
      expect(entries.sort()).toEqual([
        expect.stringMatching(/^memory\.pre-rebuild-/u),
        "memory.revision",
      ]);
      expect(clearRebuildIndexes).toHaveBeenCalledExactlyOnceWith(
        subject("agent_a", "human_a"),
      );

      const status = await fetch(
        `${server.url}/internal/v1/rebuild?owner_actor_id=human_a`,
        { headers },
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ total: 1 });
      expect(rebuildStatus).toHaveBeenCalledWith("agent_a");
      expect(
        (
          await fetch(
            `${server.url}/internal/v1/rebuild?memory_subject_key=agent_a&from=2026-09-26`,
            { headers },
          )
        ).status,
      ).toBe(400);

      enqueueRebuild.mockRestore();
      const disabled = await start({ memory_subject_key: "agent_a" });
      expect(disabled.status).toBe(409);
      expect((await disabled.json()).error.code).toBe("rebuild_unavailable");
    } finally {
      await server.close();
    }
  });

  it("reports a configured Raw store", async () => {
    const dataRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-failures-"),
    );
    roots.push(dataRoot);
    const failedSources = vi.fn().mockResolvedValue({
      total: 1,
      by_owner: [{ tenant_id: "t", owner_id: "o", count: 1 }],
      items: [],
    });
    const server = await startMemoryServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(schedule, async () => undefined),
      serviceToken: "test",
      chunkFailures: { failedSources },
    });
    try {
      const summary = await (
        await fetch(`${server.url}/internal/v1/health/failures`, {
          headers: { authorization: "Bearer test" },
        })
      ).json();
      expect(summary.raw_chunk_sources).toMatchObject({
        configured: true,
        total: 1,
      });
      expect(summary).not.toHaveProperty("openwiki_jobs");
      expect(failedSources).toHaveBeenCalledWith(200);
    } finally {
      await server.close();
    }
  });
});
