import { describe, expect, it } from "vitest";

import {
  fetchTeamHubSession,
  createTeamHubAgentRuntimeStateClient,
  getTeamHubPersonalWikiDocumentRevision,
  getTeamHubPersonalWikiDocumentVersion,
  postTeamHubMemoryWikiRefresh,
} from "../generated/typescript/src/teamhub-internal/client.js";

describe("generated TeamHub personal Wiki projection client", () => {
  it("uses the Memory workload token and exact revision coordinates", async () => {
    const requests: Request[] = [];
    const common = {
      baseUrl: "https://teamhub.example/base",
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 200 });
      },
      serviceToken: "memory-token",
    };

    await getTeamHubPersonalWikiDocumentRevision({
      ...common,
      actorId: "actor/one",
    });
    await getTeamHubPersonalWikiDocumentVersion({
      ...common,
      actorId: "actor/one",
      documentId: "document/three",
      documentVersionId: "version four",
      wikiRevisionId: "revision two",
    });
    await fetchTeamHubSession({
      ...common,
      tenantId: "tenant/one",
      documentVersionId: "version/four",
    });
    await postTeamHubMemoryWikiRefresh({
      ...common,
      actorId: "actor/one",
      body: {
        date: "2026-09-01",
        tenant_id: "tenant_1",
      },
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://teamhub.example/base/v0/personal-wikis/actor%2Fone/document-revision",
      "https://teamhub.example/base/v0/personal-wikis/actor%2Fone/document-revisions/revision%20two/documents/document%2Fthree/versions/version%20four/content",
      "https://teamhub.example/base/v0/memory/fetch_session/tenants/tenant%2Fone/document-versions/version%2Ffour",
      "https://teamhub.example/base/v0/personal-wikis/actor%2Fone/memory-refresh",
    ]);
    expect(
      requests.map((request) => request.headers.get("authorization")),
    ).toEqual([
      "Bearer memory-token",
      "Bearer memory-token",
      "Bearer memory-token",
      "Bearer memory-token",
    ]);
    await expect(requests[3]?.json()).resolves.toEqual({
      date: "2026-09-01",
      tenant_id: "tenant_1",
    });
  });
});

describe("generated TeamHub Agent service epoch and Run client", () => {
  it("opens the process epoch and claims a Run with workload identity", async () => {
    const requests: Request[] = [];
    const client = createTeamHubAgentRuntimeStateClient({
      baseUrl: "https://teamhub.example/api/?stale=true#fragment",
      serviceToken: "service-token",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 200 });
      },
    });

    const start = { epoch: "agent-service-one" };
    const claim = {
      context_key: '["meta","agent-one","room","room-one"]',
      epoch: start.epoch,
      claim_id: "claim-one",
    };
    await client.startEpoch(start);
    await client.claimRun(claim);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://teamhub.example/api/v0/agent-runtime/epochs",
      "https://teamhub.example/api/v0/agent-runtime/runs/claim",
    ]);
    expect(requests.map(({ method }) => method)).toEqual(["POST", "POST"]);
    expect(
      requests.map(({ headers }) => Object.fromEntries(headers.entries())),
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        authorization: "Bearer service-token",
        "content-type": "application/json",
      })),
    );
    expect(
      await Promise.all(requests.map((request) => request.json())),
    ).toEqual([start, claim]);
  });
});

it("passes the optional Wiki validator and exposes a bodyless 304", async () => {
  const response = await getTeamHubPersonalWikiDocumentRevision({
    actorId: "owner_a",
    baseUrl: "https://teamhub.test",
    serviceToken: "fixture",
    ifNoneMatch: '"previous"',
    fetch: async (_input, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe(
        '"previous"',
      );
      return new Response(null, {
        status: 304,
        headers: { etag: '"previous"' },
      });
    },
  });
  expect(response.status).toBe(304);
  expect(response.headers.get("etag")).toBe('"previous"');
  expect(await response.text()).toBe("");
});
