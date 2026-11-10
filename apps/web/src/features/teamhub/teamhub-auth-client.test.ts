import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";

import { teamHubData } from "./teamhub-api";
import { createHttpTeamHubClient, TeamHubError } from "./teamhub-client";

describe("TeamHub Account client", () => {
  it("preserves a server-provided Retry-After delay on rate limit errors", async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Wait before trying again.",
          },
        },
        429,
        { "Retry-After": "73" },
      ),
    );
    const client = createHttpTeamHubClient({ fetchRequest });

    await expect(
      teamHubData(
        client.api.POST("/v0/auth/login", {
          body: { identifier: "member@example.com", password: "secret" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 73,
      status: 429,
    });
  });

  it("does not turn an expected login 401 into a global auth transition", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Username or password is incorrect.",
            request_id: "request-login",
          },
        },
        401,
      ),
    );
    const client = createHttpTeamHubClient({
      fetchRequest,
      onAuthenticationRequired,
    });

    await expect(
      teamHubData(
        client.api.POST("/v0/auth/login", {
          body: { identifier: "jenny@northstar.example", password: "wrong" },
        }),
      ),
    ).rejects.toBeInstanceOf(TeamHubError);
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("authentication cancellation", () => {
  it("forwards cancellation through login, Cookie verification and tenant HTTP adapters", async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({}));
    const client = createHttpTeamHubClient({ fetchRequest });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    await teamHubData(
      client.api.POST("/v0/auth/login", {
        body: { identifier: "alice@example.com", password: "password" },
        ...options,
      }),
    );
    await teamHubData(client.api.GET("/v0/session", options));
    await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
        params: { path: { tenantId: "tenant-current" } },
        ...options,
      }),
    );
    expect(fetchRequest).toHaveBeenCalledTimes(3);
    controller.abort();
    for (const [, init] of await sentRequests(fetchRequest))
      expect(init.signal?.aborted).toBe(true);
  });
});
