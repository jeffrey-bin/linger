import { afterEach, describe, expect, it } from "vitest";

import { startHttpHost, type HttpHost } from "../src/http-host.js";

const hosts: HttpHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

const start = async (): Promise<HttpHost> => {
  const host = await startHttpHost({ host: "127.0.0.1", port: 0 });
  hosts.push(host);
  return host;
};

const text = (body: string) => () => new Response(body);

describe("startHttpHost", () => {
  it("routes each path to the longest mounted prefix", async () => {
    const host = await start();
    host.mount({ prefixes: ["/internal/v1/", "/runs"], fetch: text("memory") });
    host.mount({
      prefixes: ["/internal/v1/wiki-refreshes/"],
      fetch: text("llm-wiki"),
    });
    host.mount({ prefixes: ["/v1/"], fetch: text("agent") });
    host.finishStartup();

    const body = async (path: string) =>
      (await fetch(`${host.url}${path}`)).text();
    expect(await body("/internal/v1/query")).toBe("memory");
    expect(await body("/runs/view")).toBe("memory");
    expect(await body("/internal/v1/wiki-refreshes/r1/candidates")).toBe(
      "llm-wiki",
    );
    expect(await body("/v1/model-calls")).toBe("agent");
    expect((await fetch(`${host.url}/v0/unknown`)).status).toBe(404);
  });

  it("answers 503 for unmounted paths and probes until startup ends", async () => {
    const host = await start();

    expect((await fetch(`${host.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${host.url}/startupz`)).status).toBe(503);
    const unready = await fetch(`${host.url}/readyz`);
    expect(unready.status).toBe(503);
    await expect(unready.json()).resolves.toEqual({
      reason: "starting",
      status: "not_ready",
    });
    const early = await fetch(`${host.url}/v1/model-calls`);
    expect(early.status).toBe(503);
    await expect(early.json()).resolves.toMatchObject({
      error: { code: "SERVICE_NOT_READY" },
    });

    host.finishStartup();
    expect((await fetch(`${host.url}/startupz`)).status).toBe(200);
    expect((await fetch(`${host.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${host.url}/v1/model-calls`)).status).toBe(404);
  });

  it("aggregates every role's readiness", async () => {
    const host = await start();
    let agentReady = false;
    host.mount({ prefixes: ["/runs"], fetch: text("memory") });
    host.mount({
      prefixes: ["/v1/"],
      fetch: text("agent"),
      readiness: () =>
        agentReady
          ? { ready: true }
          : { ready: false, reason: "teamhub_unavailable" },
    });
    host.mount({
      prefixes: ["/v0/document-normalizations"],
      fetch: text("llm-wiki"),
      readiness: () => {
        throw new Error("probe failed");
      },
    });
    host.finishStartup();

    const first = await fetch(`${host.url}/readyz`);
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({
      reason: "teamhub_unavailable",
      status: "not_ready",
    });
    agentReady = true;
    await expect((await fetch(`${host.url}/readyz`)).json()).resolves.toEqual({
      reason: "dependency_check_failed",
      status: "not_ready",
    });
  });

  it("accepts only GET on probes and rejects overlapping mounts", async () => {
    const host = await start();
    host.finishStartup();

    const post = await fetch(`${host.url}/healthz`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    host.mount({ prefixes: ["/v1/"], fetch: text("agent") });
    expect(() => host.mount({ prefixes: ["/v1/"], fetch: text("x") })).toThrow(
      "HTTP route prefix already mounted: /v1/",
    );
    expect(() =>
      host.mount({ prefixes: ["/readyz"], fetch: text("x") }),
    ).toThrow("Invalid HTTP route prefix: /readyz");
  });

  it("reports a loopback URL for a wildcard listener", async () => {
    const host = await startHttpHost({ host: "0.0.0.0", port: 0 });
    hosts.push(host);
    expect(host.host).toBe("0.0.0.0");
    expect(host.url).toBe(`http://127.0.0.1:${host.port}`);
    expect((await fetch(`${host.url}/healthz`)).status).toBe(200);
  });
});
