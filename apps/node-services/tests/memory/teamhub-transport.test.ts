import { expect, it, vi } from "vitest";
import {
  teamHubFetch,
  withTeamHubTrace,
} from "../../src/memory/teamhub-transport.js";
import { readPublishedWiki } from "../../src/memory/teamhub-wiki.js";
import { fetchTeamHubDocumentVersionContent } from "../../src/memory/teamhub-content.js";

it("sets memory UA and propagates valid task trace without adding sensitive headers", async () => {
  const trace = "00-11111111111111111111111111111111-2222222222222222-01";
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toMatch(/^linger-memory\//u);
    expect(headers.get("traceparent")).toBe(trace);
    expect(headers.has("baggage")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    return new Response("content");
  });
  const access = {
    baseUrl: "http://teamhub.test",
    token: "fixture",
    fetch: fetcher,
  };
  await withTeamHubTrace(trace, async () => {
    await fetchTeamHubDocumentVersionContent(access, "tenant_a", "version_a");
    await expect(readPublishedWiki(access, "owner_a")).rejects.toThrow();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await withTeamHubTrace("invalid", async () => {
    await teamHubFetch(async (_input, init) => {
      expect(new Headers(init?.headers).has("traceparent")).toBe(false);
      return new Response();
    })("http://teamhub.test");
  });
});
