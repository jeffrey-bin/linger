import { describe, expect, it, vi } from "vitest";
import {
  AgentIdentityHttpError,
  createAgentIdentityHttpResolver,
} from "../../../../src/agent/executor/http/agent-identity-http-resolver.js";

const sponsor = {
  id: "actor_sponsor",
  display_name: "Human Sponsor",
} as const;

describe("Agent identity HTTP resolver", () => {
  it("resolves the Agent Actor ID through the authenticated TeamHub callback", async () => {
    const fetchRequest = vi.fn(async () =>
      Response.json({
        agent_id: "agent_123",
        agent_type: "anotherme",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor,
        represented_human: {
          id: "actor_human",
          display_name: "Represented Human",
          memory: {
            version: 3,
            markdown: "# Memory\n- Lead with the conclusion [2026-11-01]",
          },
        },
      }),
    );
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test/base",
      serviceToken: "service-token",
      fetch: fetchRequest,
    });

    await expect(resolver.resolveIdentity("agent_123")).resolves.toEqual({
      actorId: "actor_456",
      agentType: "anotherme",
      representedHuman: {
        actorId: "actor_human",
        displayName: "Represented Human",
        memory: {
          version: 3,
          markdown: "# Memory\n- Lead with the conclusion [2026-11-01]",
        },
      },
      sponsor: {
        actorId: "actor_sponsor",
        displayName: "Human Sponsor",
      },
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://teamhub.example.test/base/v0/agents/agent_123/identity",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { authorization: "Bearer service-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a retired Builder identity", async () => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () =>
        Response.json({
          agent_id: "agent_123",
          agent_type: "builder",
          agent_build_id: "agent_build_789",
          actor: {
            id: "actor_456",
            kind: "agent",
            display_name: "Agent Builder",
          },
          sponsor,
        }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toThrow(
      'agent_type must be "general" or "anotherme"',
    );
  });

  it("rejects unsuccessful identity responses with bounded response context", async () => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(
        async () => new Response("mapping is not ready", { status: 404 }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind: "not_found",
      status: 404,
      identityUrl: "https://teamhub.example.test/v0/agents/agent_123/identity",
      responseBody: "mapping is not ready",
    } satisfies Partial<AgentIdentityHttpError>);
  });

  it.each([
    [401, "permanent"],
    [403, "permanent"],
    [500, "transient"],
    [503, "transient"],
  ] as const)("classifies an HTTP %s response as %s", async (status, kind) => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () => new Response(null, { status })),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind,
      status,
    } satisfies Partial<AgentIdentityHttpError>);
  });

  it("classifies transport failures as transient", async () => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind: "transient",
      status: null,
    } satisfies Partial<AgentIdentityHttpError>);
  });

  it("classifies malformed JSON as permanent", async () => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind: "permanent",
      status: 200,
    } satisfies Partial<AgentIdentityHttpError>);
  });

  it.each([
    [
      "invalid Agent type",
      {
        agent_id: "agent_123",
        agent_type: "admin",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor,
      },
    ],
    [
      "mismatched Agent ID",
      {
        agent_id: "agent_other",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor,
      },
    ],
    [
      "non-Agent Actor",
      {
        agent_id: "agent_123",
        actor: {
          id: "actor_456",
          kind: "human",
          display_name: "Research Agent",
        },
        sponsor,
      },
    ],
    [
      "missing Actor ID",
      {
        agent_id: "agent_123",
        actor: {
          id: "",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor,
      },
    ],
    [
      "missing display name",
      {
        agent_id: "agent_123",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "",
        },
        sponsor,
      },
    ],
    [
      "missing sponsor Actor ID",
      {
        agent_id: "agent_123",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor: { ...sponsor, id: "" },
      },
    ],
    [
      "matching Agent and sponsor Actor IDs",
      {
        agent_id: "agent_123",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor: { ...sponsor, id: "actor_456" },
      },
    ],
    [
      "missing sponsor display name",
      {
        agent_id: "agent_123",
        actor: {
          id: "actor_456",
          kind: "agent",
          display_name: "Research Agent",
        },
        sponsor: { ...sponsor, display_name: "" },
      },
    ],
  ])("rejects a %s response", async (_name, body) => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () =>
        Response.json({ agent_type: "general", ...body }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind: "permanent",
      status: 200,
    });
  });

  it("reports every supported Agent type for an invalid type", async () => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () =>
        Response.json({
          agent_id: "agent_123",
          agent_type: "admin",
          actor: {
            id: "actor_456",
            kind: "agent",
            display_name: "Research Agent",
          },
          sponsor,
        }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toThrow(
      'agent_type must be "general" or "anotherme"',
    );
  });

  it.each([
    [
      "represented Human on a general Agent",
      "general",
      {
        id: "actor_human",
        display_name: "Represented Human",
      },
    ],
    [
      "memory.md without a positive version",
      "anotherme",
      {
        id: "actor_human",
        display_name: "Represented Human",
        memory: { version: 0, markdown: "# Memory" },
      },
    ],
    [
      "memory.md over its byte limit",
      "anotherme",
      {
        id: "actor_human",
        display_name: "Represented Human",
        memory: { version: 1, markdown: "x".repeat(16_385) },
      },
    ],
  ])("rejects %s", async (_name, agentType, representedHuman) => {
    const resolver = createAgentIdentityHttpResolver({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "service-token",
      fetch: vi.fn(async () =>
        Response.json({
          agent_id: "agent_123",
          agent_type: agentType,
          actor: {
            id: "actor_456",
            kind: "agent",
            display_name: "Research Agent",
          },
          sponsor,
          represented_human: representedHuman,
        }),
      ),
    });

    await expect(resolver.resolveIdentity("agent_123")).rejects.toMatchObject({
      name: "AgentIdentityHttpError",
      kind: "permanent",
      status: 200,
    });
  });
});
