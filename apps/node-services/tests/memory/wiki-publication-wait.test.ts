import { describe, expect, it, vi } from "vitest";
import {
  readPublishedWiki,
  waitForCurrentPublishedWiki,
} from "../../src/memory/teamhub-wiki.js";
const snapshot = (current: boolean, state = "idle") => ({
  wiki_revision_id: "revision_1",
  published_at: "2026-09-29T00:00:00Z",
  is_current: current,
  wiki_state: state,
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
function access(fetcher: typeof fetch) {
  return { baseUrl: "http://teamhub.test", token: "test-only", fetch: fetcher };
}
describe("Wiki publication completion", () => {
  it("keeps unpublished failure optional for report and index readers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "WIKI_GENERATION_FAILED",
            message: "Personal Wiki generation failed",
          },
        },
        { status: 409 },
      ),
    );
    await expect(
      readPublishedWiki(access(fetcher), "actor_a"),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("waits past a clean but stale Revision until its source heads are current", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot(false)))
      .mockResolvedValueOnce(Response.json(snapshot(true)));
    const result = await waitForCurrentPublishedWiki(
      access(fetcher),
      "actor_a",
      { timeoutMs: 1000, pollMs: 1 },
    );
    expect(result.isCurrent).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retries a transient read error without claiming success", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(snapshot(true)));
    await expect(
      waitForCurrentPublishedWiki(access(fetcher), "actor_a", {
        timeoutMs: 1000,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ isCurrent: true });
  });
  it("reports an explicitly failed generation and never substitutes the old Revision", async () => {
    await expect(
      waitForCurrentPublishedWiki(
        access(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json(snapshot(false, "failed"))),
        ),
        "actor_a",
        { timeoutMs: 1000, pollMs: 1 },
      ),
    ).rejects.toThrow("generation failed");
  });
  it("waits only until no refresh runs when asked for an idle Wiki", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot(false, "refreshing")))
      .mockResolvedValueOnce(Response.json(snapshot(false, "failed")));
    // A failed refresh has finished too; a stale Revision is not waited past.
    await expect(
      waitForCurrentPublishedWiki(access(fetcher), "actor_a", {
        until: "idle",
        timeoutMs: 1000,
        pollMs: 1,
      }),
    ).resolves.toMatchObject({ isCurrent: false, state: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("ends immediately when the first publication failed without any old Revision", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "WIKI_GENERATION_FAILED",
            message: "Personal Wiki generation failed",
          },
        },
        { status: 409 },
      ),
    );
    const sleep = vi.fn(async () => {});
    await expect(
      waitForCurrentPublishedWiki(access(fetcher), "actor_a", {
        timeoutMs: 1000,
        sleep,
      }),
    ).rejects.toThrow("Personal Wiki generation failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("treats a failed first publication as idle with no published Wiki", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { code: "WIKI_GENERATION_FAILED" } },
          { status: 409 },
        ),
      );
    const sleep = vi.fn(async () => {});
    await expect(
      waitForCurrentPublishedWiki(access(fetcher), "actor_a", {
        until: "idle",
        timeoutMs: 1000,
        sleep,
      }),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("bounds waiting for unpublished work", async () => {
    await expect(
      waitForCurrentPublishedWiki(
        access(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 404 })),
        ),
        "actor_a",
        { timeoutMs: 5, pollMs: 1 },
      ),
    ).rejects.toThrow("Timed out");
  });
});

it("uses task-local ETags through 304s without resetting backoff", async () => {
  let now = 0;
  const times: number[] = [];
  const codes: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    times.push(now);
    const current = now >= 80_000;
    if (times.length > 1)
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"stale"');
    const code = times.length === 1 || current ? 200 : 304;
    codes.push(code);
    return code === 304
      ? new Response(null, { status: 304, headers: { etag: '"stale"' } })
      : Response.json(snapshot(current), {
          headers: { etag: current ? '"current"' : '"stale"' },
        });
  });
  await waitForCurrentPublishedWiki(access(fetcher), "owner_a", {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 1,
  });
  expect(times).toEqual([
    0, 2000, 6000, 14000, 29000, 44000, 59000, 74000, 89000,
  ]);
  expect(codes).toEqual([200, 304, 304, 304, 304, 304, 304, 304, 200]);
});

it("honors Retry-After and the remaining deadline, and fails authorization immediately", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 429, headers: { "retry-after": "30" } }),
    );
  await expect(
    waitForCurrentPublishedWiki(access(fetcher), "owner_a", {
      timeoutMs: 35_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      random: () => 1,
    }),
  ).rejects.toThrow("Timed out");
  expect(sleeps).toEqual([30_000, 5000]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const code of [401, 403]) {
    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: code }));
    await expect(
      waitForCurrentPublishedWiki(access(rejected), "owner_a"),
    ).rejects.toThrow(String(code));
    expect(rejected).toHaveBeenCalledOnce();
  }
});

it("bounds in-flight requests and propagates caller cancellation", async () => {
  const controller = new AbortController();
  const fetcher: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
        { once: true },
      );
    });
  await expect(
    waitForCurrentPublishedWiki(access(fetcher), "owner_a", { timeoutMs: 10 }),
  ).rejects.toThrow("Timed out");
  const waiting = waitForCurrentPublishedWiki(access(fetcher), "owner_b", {
    signal: controller.signal,
  });
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});

it("recovers one unpaired 304 with an unconditional read", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json(snapshot(true)));
  expect(
    (await waitForCurrentPublishedWiki(access(fetcher), "owner_a")).isCurrent,
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves terminal failure handling after an unpaired 304", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: "WIKI_GENERATION_FAILED" } },
        { status: 409 },
      ),
    )
    .mockResolvedValue(Response.json(snapshot(true)));
  const sleep = vi.fn(async () => {});
  await expect(
    waitForCurrentPublishedWiki(access(fetcher), "owner_a", { sleep }),
  ).rejects.toThrow("Personal Wiki generation failed");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sleep).not.toHaveBeenCalled();
});
