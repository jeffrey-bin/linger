import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";
import { createHttpTeamHubClient } from "./teamhub-client";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

describe("TeamHub Personal Profile client", () => {
  it("maps Profile reads, generations and Insight deletion to the public contract", async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ history: [], has_more: false }))
      .mockResolvedValueOnce(jsonResponse({ id: "generation/a" }, 202))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });
    await client.getPersonalProfile("tenant/a");
    await client.createPersonalProfileGeneration("tenant/a", {
      sources: [{ kind: "connection", connection_id: "connection/a" }],
    });
    await client.deletePersonalInsight("tenant/a", "insight/a");
    expect(
      (await sentRequests(fetchRequest)).map(([url, init]) => ({
        body: init?.body ? JSON.parse(requestBodyText(init.body)) : undefined,
        key: new Headers(init?.headers).get("Idempotency-Key"),
        method: init?.method,
        url: requestUrlText(url),
      })),
    ).toEqual([
      {
        body: undefined,
        key: null,
        method: "GET",
        url: "https://teamhub.example.test/v0/tenants/tenant%2Fa/personal-profile",
      },
      {
        body: {
          sources: [{ kind: "connection", connection_id: "connection/a" }],
        },
        key: null,
        method: "POST",
        url: "https://teamhub.example.test/v0/tenants/tenant%2Fa/personal-profile-generations",
      },
      {
        body: undefined,
        key: null,
        method: "DELETE",
        url: "https://teamhub.example.test/v0/tenants/tenant%2Fa/personal-insights/insight%2Fa",
      },
    ]);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}
