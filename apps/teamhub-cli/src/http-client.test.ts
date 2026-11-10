import { describe, expect, it, vi } from "vitest";
import {
  createTeamHubClient,
  operationHeaders,
  teamHubData,
} from "./http-client.js";
import { displayText } from "./display-text.js";
import { requestBodyText } from "./test-support/fetch-text.js";

const config = {
  url: "https://teamhub.example",
  token: "th_agent_fixture",
  identityKey: "identity",
  scope: { kind: "room" as const, id: "room_one" },
};
describe("direct TeamHub HTTP client", () => {
  it("sends stable identity and business target directly without internal lifecycle fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ accepted: true }));
    const client = createTeamHubClient(config, { fetch: fetcher });
    expect(
      await teamHubData(
        client.api.POST("/api/agent/v1/direct-messages", {
          body: { content: "Hello" } as never,
          headers: operationHeaders("reply-1"),
        }),
      ),
    ).toEqual({ accepted: true });
    expect(displayText(fetcher.mock.calls[0]![0])).toBe(
      "https://teamhub.example/api/agent/v1/direct-messages",
    );
    const options = fetcher.mock.calls[0]![1]!;
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe("Bearer th_agent_fixture");
    expect(headers.get("x-teamhub-context-kind")).toBe("room");
    expect(headers.get("x-teamhub-context-id")).toBe("room_one");
    expect(headers.get("x-teamhub-operation-id")).toBe("reply-1");
    expect(JSON.parse(requestBodyText(options.body))).toEqual({
      content: "Hello",
    });
    expect(options.redirect).toBe("error");
  });
  it("never forwards a credential to absolute or protocol-relative endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createTeamHubClient(config, { fetch: fetcher });
    for (const endpoint of [
      "https://other.example/api",
      "//other.example/api",
      "/api/../other",
      "/api?redirect=x",
    ]) {
      await expect(
        client.request(endpoint, { method: "POST" }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not retry uncertain writes and includes the operation ID in the error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("response lost"));
    const client = createTeamHubClient(config, { fetch: fetcher });
    await expect(
      client.api.POST("/api/agent/v1/direct-messages", {
        body: {} as never,
        headers: operationHeaders("stable-reply"),
      }),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operation_id: "stable-reply" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves structured TeamHub permission and conflict errors", async () => {
    const client = createTeamHubClient(config, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "version_conflict",
              message: "Document changed",
              details: { current_version_id: "v2" },
            },
          },
          { status: 409 },
        ),
      ),
    });
    await expect(
      client.api.POST("/api/agent/v1/documents", { body: {} as never }),
    ).rejects.toMatchObject({
      code: "version_conflict",
      details: { current_version_id: "v2" },
    });
  });
  it("sends configured identity assertions and the Run to the credential authority and keeps shared links anonymous", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ accepted: true }));
    const client = createTeamHubClient(
      {
        ...config,
        identity: { tenantId: "tenant_one", agentId: "agent_one" },
        runId: "run_one",
      },
      { fetch: fetcher },
    );
    await client.api.POST("/api/agent/v1/direct-messages", {
      body: {} as never,
    });
    const authenticated = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect(authenticated.get("x-teamhub-expected-agent-id")).toBe("agent_one");
    expect(authenticated.get("x-teamhub-expected-tenant-id")).toBe(
      "tenant_one",
    );
    expect(authenticated.get("x-teamhub-run-id")).toBe("run_one");
    await client.request("/v0/shared-documents/content", {
      method: "POST",
      body: JSON.stringify({ token: "doc_link_fixture" }),
    });
    const anonymous = new Headers(fetcher.mock.calls[1]![1]!.headers);
    for (const key of [
      "authorization",
      "x-teamhub-context-id",
      "x-teamhub-expected-agent-id",
      "x-teamhub-run-id",
    ])
      expect(anonymous.has(key)).toBe(false);
  });
});
