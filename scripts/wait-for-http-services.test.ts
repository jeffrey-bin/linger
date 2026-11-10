import { describe, expect, it, vi } from "vitest";

import { waitForHttpServices } from "./wait-for-http-services";

describe("local HTTP service readiness", () => {
  it("retries pending services until each one is healthy", async () => {
    const attempts = new Map<string, number>();
    const sleep = vi.fn(async () => undefined);
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return new Response(undefined, {
        status: url.includes("teamhub") && attempt === 1 ? 503 : 200,
      });
    };

    await waitForHttpServices(
      ["http://teamhub.test/healthz", "http://agent.test/health"],
      { fetcher, sleep, timeoutMs: 1_000 },
    );

    expect(attempts).toEqual(
      new Map([
        ["http://teamhub.test/healthz", 2],
        ["http://agent.test/health", 1],
      ]),
    );
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("reports every service that remains unavailable", async () => {
    await expect(
      waitForHttpServices(
        ["http://teamhub.test/healthz", "http://agent.test/health"],
        { timeoutMs: 0 },
      ),
    ).rejects.toThrow(
      "Timed out waiting for local services: http://teamhub.test/healthz, http://agent.test/health",
    );
  });

  it("rejects credentials in readiness URLs", async () => {
    await expect(
      waitForHttpServices(["http://user:secret@teamhub.test/healthz"]),
    ).rejects.toThrow("Local service URL must be an HTTP(S) URL");
  });
});
