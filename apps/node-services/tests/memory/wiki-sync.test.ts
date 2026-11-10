import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWikiSyncCli } from "../../src/memory/wiki-sync-cli.js";
import type { AnotherMeSubject } from "../../src/memory/types.js";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

const roots: string[] = [];
const subject: AnotherMeSubject = {
  tenantId: "tenant_acme",
  agentActorId: "actor_agent",
  agentManagementId: "agent_alice",
  agentDisplayName: "Alice's Another Me",
  representedHumanActorId: "actor_alice",
  representedHumanDisplayName: "Alice",
  representedHumanAccountId: "account_alice",
  memorySubjectKey: "agent_alice",
};

function accepted(): Response {
  return Response.json({
    refresh_id: "refresh_1",
    refresh_status: "accepted",
    wiki_id: "wiki_1",
  });
}

async function memoryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-sync-"));
  roots.push(root);
  vi.stubEnv("TEAMHUB_BASE_URL", "http://teamhub.test");
  vi.stubEnv("LINGER_SECRET_SEED", "test-seed-0123456789abcdef0123456789");
  return root;
}

async function stageCollection(
  root: string,
  date: string,
  subjects: Partial<AnotherMeSubject>[],
  ...segments: string[]
): Promise<void> {
  const directory = path.join(root, "updates", "sessionly", date, ...segments);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "collection.json"),
    JSON.stringify({ subjects, rooms: [] }),
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("wiki sync", () => {
  it("indexes the subject's Session Raw before it requests the refresh", async () => {
    const root = await memoryRoot();
    const date = "2026-09-02";
    await stageCollection(root, date, [subject], "tenant_acme", "room_one");
    const order: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => {
      order.push("refresh");
      return accepted();
    });
    vi.stubGlobal("fetch", fetcher);

    const [result] = await runWikiSyncCli(
      ["--date", date, "--memory-root", root],
      {
        indexSessionRaw: async (agentId) => {
          order.push(`index:${agentId}`);
        },
      },
    );

    expect(order).toEqual(["index:agent_alice", "refresh"]);
    expect(requestUrlText(fetcher.mock.calls[0]?.[0])).toBe(
      "http://teamhub.test/v0/personal-wikis/actor_alice/memory-refresh",
    );
    // TeamHub reads the Sessions from the index; no content is sent.
    expect(
      JSON.parse(requestBodyText(fetcher.mock.calls[0]?.[1]?.body)),
    ).toEqual({ date, tenant_id: "tenant_acme" });
    expect(result).toEqual({
      agent_id: "agent_alice",
      actor_id: "actor_alice",
      memory_subject_key: "agent_alice",
      refresh_id: "refresh_1",
      refresh_status: "accepted",
      wiki_id: "wiki_1",
    });
  });

  it("requests all changed sources for a subject without a Session collection", async () => {
    const root = await memoryRoot();
    const date = "2026-09-03";
    const collector = await import("../../src/memory/collector.js");
    const enrolled = vi
      .spyOn(collector, "loadAnotherMeSubjects")
      .mockResolvedValue([subject]);
    const fetcher = vi.fn<typeof fetch>(async () => accepted());
    vi.stubGlobal("fetch", fetcher);
    try {
      await runWikiSyncCli([
        "--date",
        date,
        "--memory-root",
        root,
        "--memory-subject-key",
        subject.memorySubjectKey,
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestUrlText(fetcher.mock.calls[0]?.[0])).toBe(
        "http://teamhub.test/v0/personal-wikis/actor_alice/memory-refresh",
      );
      expect(
        JSON.parse(requestBodyText(fetcher.mock.calls[0]?.[1]?.body)),
      ).toEqual({
        tenant_id: subject.tenantId,
        date,
      });
    } finally {
      enrolled.mockRestore();
    }
  });

  it("sends a meeting again once the running refresh finishes, a bounded number of times", async () => {
    const root = await memoryRoot();
    const date = "2026-09-02";
    await stageCollection(root, date, [subject], "tenant_acme", "room_one");
    const busy = () =>
      Response.json({
        refresh_id: "refresh_night",
        refresh_status: "in_progress",
        wiki_id: "wiki_1",
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(accepted());
    vi.stubGlobal("fetch", fetcher);
    const waitForRunningRefresh = vi.fn(async () => undefined);
    const argv = [
      "--date",
      date,
      "--memory-root",
      root,
      "--capture-id",
      "capture_1",
    ];

    const [result] = await runWikiSyncCli(argv, { waitForRunningRefresh });

    expect(waitForRunningRefresh).toHaveBeenCalledExactlyOnceWith(
      "actor_alice",
    );
    expect(
      fetcher.mock.calls.map(([, init]) =>
        JSON.parse(requestBodyText(init?.body)),
      ),
    ).toEqual([
      { date, tenant_id: "tenant_acme", capture_id: "capture_1" },
      { date, tenant_id: "tenant_acme", capture_id: "capture_1" },
    ]);
    expect(result?.refresh_status).toBe("accepted");

    // A Wiki that stays busy gets three resends; the night takes it in.
    fetcher.mockReset();
    fetcher.mockImplementation(async () => busy());
    waitForRunningRefresh.mockClear();
    const [skipped] = await runWikiSyncCli(argv, { waitForRunningRefresh });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(waitForRunningRefresh).toHaveBeenCalledTimes(3);
    expect(skipped?.refresh_status).toBe("in_progress");
  });

  it("does not request a refresh when the Sessions cannot be indexed", async () => {
    const root = await memoryRoot();
    const date = "2026-09-02";
    await stageCollection(root, date, [subject], "tenant_acme", "room_one");
    const fetcher = vi.fn<typeof fetch>(async () => accepted());
    vi.stubGlobal("fetch", fetcher);

    await expect(
      runWikiSyncCli(["--date", date, "--memory-root", root], {
        indexSessionRaw: async () => {
          throw new Error("index unavailable");
        },
      }),
    ).rejects.toThrow("index unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries a transient TeamHub failure and records no_sources", async () => {
    const root = await memoryRoot();
    const date = "2026-09-18";
    await stageCollection(root, date, [subject], "tenant_acme", "room_one");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "serialization failure" }, { status: 500 }),
      )
      .mockResolvedValueOnce(
        Response.json({ refresh_status: "no_sources", wiki_id: "wiki_1" }),
      );
    vi.stubGlobal("fetch", fetcher);
    await runWikiSyncCli(["--memory-root", root, "--date", date]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const result = JSON.parse(
      await fs.readFile(
        path.join(root, "updates", "wiki-sync", date, "result.json"),
        "utf8",
      ),
    );
    expect(result.results[0].refresh_status).toBe("no_sources");
  });

  it("requests one refresh for several dates and records them", async () => {
    const root = await memoryRoot();
    const dates = ["2026-08-25", "2026-09-02"];
    for (const date of dates)
      await stageCollection(root, date, [subject], subject.memorySubjectKey);
    const fetcher = vi.fn<typeof fetch>(async () => accepted());
    vi.stubGlobal("fetch", fetcher);

    await runWikiSyncCli([
      "--date",
      dates[0]!,
      "--date",
      dates[1]!,
      "--memory-root",
      root,
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(requestBodyText(fetcher.mock.calls[0]?.[1]?.body)).date,
    ).toBe(dates[1]);
    const result = JSON.parse(
      await fs.readFile(
        path.join(root, "updates", "wiki-sync", dates[1]!, "result.json"),
        "utf8",
      ),
    ) as { source_dates: string[] };
    expect(result.source_dates).toEqual(dates);
  });

  it("keeps concurrent rebuild receipts per subject beside the calendar receipt", async () => {
    const root = await memoryRoot();
    const date = "2026-09-22";
    const keys = ["agent_alice", "agent_bob"];
    for (const key of keys)
      await stageCollection(
        root,
        date,
        [
          {
            tenantId: "tenant_acme",
            agentManagementId: key,
            representedHumanActorId: `actor_${key}`,
            memorySubjectKey: key,
          },
        ],
        key,
        "tenant_acme",
        "room_one",
      );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => accepted()),
    );
    const sync = (key: string, subjectResult?: boolean) =>
      runWikiSyncCli(
        ["--date", date, "--memory-root", root, "--memory-subject-key", key],
        { subjectResult },
      );
    await Promise.all(keys.map((key) => sync(key, true)));
    await sync("agent_alice");
    const read = async (...segments: string[]) =>
      (
        JSON.parse(
          await fs.readFile(
            path.join(root, "updates", "wiki-sync", date, ...segments),
            "utf8",
          ),
        ) as { results: { memory_subject_key: string }[] }
      ).results.map((result) => result.memory_subject_key);
    for (const key of keys)
      expect(await read(key, "result.json")).toEqual([key]);
    // The calendar keeps its original per-date path and format.
    expect(await read("result.json")).toEqual(["agent_alice"]);
  });
});
