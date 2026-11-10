import { describe, expect, it, vi } from "vitest";
import {
  createTeamHubAgentResourcesResolver,
  parseAgentEffectiveResources,
} from "../../../src/agent/executor/teamhub-context-resolvers.js";
import { requestUrlText } from "@linger/service-kit";

const response = () => ({
  effective_sha256: "a".repeat(64),
  connected_apps: true,
  skills: [
    {
      skill_id: "skill-one",
      manifest_id: "manifest-one",
      manifest_version: "1.2.3",
      name: "one",
      package_sha256: "b".repeat(64),
      config: { mode: "exact" },
      source: "explicit",
    },
  ],
});

describe("Agent effective resources", () => {
  it("reads current Agent configuration without a Context or session capability", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, _init) =>
      Response.json(response()),
    );
    const reader = createTeamHubAgentResourcesResolver({
      baseUrl: "https://teamhub.example/",
      serviceToken: "private-service",
      fetch,
    });
    const resources = await reader.resolve({
      agentId: "agent-1",
      signal: new AbortController().signal,
    });
    expect(requestUrlText(fetch.mock.calls[0]![0])).toBe(
      "https://teamhub.example/v0/agents/agent-1/effective-resources",
    );
    expect(
      new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe("Bearer private-service");
    expect(resources.skills[0]).toMatchObject({
      manifestId: "manifest-one",
      packageName: "one",
      config: { mode: "exact" },
    });
    expect(JSON.stringify(resources)).not.toMatch(/snapshot|access.token/u);
  });
  it("rejects repeated package identity and never reflects upstream error bodies", async () => {
    expect(() =>
      parseAgentEffectiveResources({
        ...response(),
        skills: [...response().skills, ...response().skills],
      }),
    ).toThrow();
    const reader = createTeamHubAgentResourcesResolver({
      baseUrl: "https://teamhub.example/",
      serviceToken: "private-service",
      fetch: async () => new Response("secret diagnostic", { status: 403 }),
    });
    await expect(
      reader.resolve({
        agentId: "agent-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Agent resource configuration could not be read (HTTP 403)",
    );
  });
});
