import { afterEach, describe, expect, it } from "vitest";

import { modelCallReadiness } from "../../src/llm-wiki/service.js";
import type { ModelCall } from "../../src/runtime-model-call.js";
import { stubModelCall } from "../model-call-stub.js";
import type { WikiRefreshCandidateService } from "../../src/llm-wiki/wiki-refresh-candidates.js";
import { closeWikiServers, startWikiServer } from "./wiki-server-host.js";

const serviceToken = "teamhub-service-token-for-test";

afterEach(async () => {
  await closeWikiServers();
});

describe("WikiServer", () => {
  it("does not expose the retired Run Grant MCP transport", async () => {
    const httpUrl = await startWikiServer({ serviceToken });

    const response = await fetch(`${httpUrl}/mcp`, { method: "POST" });

    expect(response.status).toBe(404);
  });

  it("does not expose legacy Actor initialize or update authority", async () => {
    const httpUrl = await startWikiServer({ serviceToken });

    const initialize = await fetch(
      `${httpUrl}/actors/actor-a/wiki/initialize`,
      {
        body: JSON.stringify(generationDispatch),
        headers: serviceHeaders(),
        method: "POST",
      },
    );
    expect(initialize.status).toBe(404);

    const update = await fetch(`${httpUrl}/actors/actor-a/wiki/update`, {
      body: JSON.stringify(generationDispatch),
      headers: serviceHeaders(),
      method: "POST",
    });
    expect(update.status).toBe(404);
  });

  it("returns not found before parsing legacy generation bodies", async () => {
    const httpUrl = await startWikiServer({ serviceToken });
    const url = `${httpUrl}/actors/actor-a/wiki/initialize`;
    for (const request of [
      { body: "{}", headers: serviceHeaders() },
      {
        body: JSON.stringify({ ...generationDispatch, extra: true }),
        headers: serviceHeaders(),
      },
      {
        body: JSON.stringify(generationDispatch),
        headers: { authorization: `Bearer ${serviceToken}` },
      },
      { body: `"${"x".repeat(17 * 1024)}"`, headers: serviceHeaders() },
    ]) {
      const response = await fetch(url, { ...request, method: "POST" });
      expect(response.status).toBe(404);
    }
  });

  it("returns not found before authenticating legacy generation URLs", async () => {
    const httpUrl = await startWikiServer({ serviceToken });

    for (const authorization of [undefined, "Bearer wrong-service-token"]) {
      const response = await fetch(
        `${httpUrl}/actors/actor-a/wiki/initialize`,
        {
          headers: authorization ? { authorization } : undefined,
          method: "POST",
        },
      );
      expect(response.status).toBe(404);
    }
  });

  it("fails closed when the candidate generator is unavailable", async () => {
    const httpUrl = await startWikiServer({ serviceToken });

    const response = await fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      {
        body: "{}",
        headers: serviceHeaders(),
        method: "POST",
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "WIKI_REFRESH_GENERATION_UNAVAILABLE",
        disposition: "retryable",
        message: "Wiki refresh candidate generation is temporarily unavailable",
      },
    });
  });

  it("is ready only once the agent role provides model calls", async () => {
    const seam: { modelCall?: ModelCall } = {};
    const httpUrl = await startWikiServer({
      readiness: () => modelCallReadiness(() => seam.modelCall),
      serviceToken,
    });
    const notReady = await fetch(`${httpUrl}/readyz`);
    expect(notReady.status).toBe(503);
    await expect(notReady.json()).resolves.toMatchObject({
      reason: "model_call_unavailable",
    });
    seam.modelCall = stubModelCall();
    expect((await fetch(`${httpUrl}/readyz`)).status).toBe(200);
  });

  it("aborts candidate generation when TeamHub disconnects", async () => {
    let started!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let candidateService!: WikiRefreshCandidateService;
    const aborted = new Promise<void>((resolve) => {
      candidateService = {
        async generate(_id: string, _body: unknown, signal?: AbortSignal) {
          signal?.addEventListener("abort", () => resolve());
          started();
          return await new Promise(() => undefined);
        },
      } as unknown as WikiRefreshCandidateService;
    });
    const httpUrl = await startWikiServer({ candidateService, serviceToken });
    const client = new AbortController();
    const response = fetch(
      `${httpUrl}/internal/v1/wiki-refreshes/refresh-a/candidates`,
      {
        body: "{}",
        headers: serviceHeaders(),
        method: "POST",
        signal: client.signal,
      },
    );
    await generationStarted;
    client.abort();
    await expect(response).rejects.toThrow();
    await aborted;
  });
});

function serviceHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${serviceToken}`,
    "content-type": "application/json",
  };
}

const generationDispatch = {
  generationId: "generation-test",
  projectionRevision: 42,
  tenantId: "tenant-test",
};
