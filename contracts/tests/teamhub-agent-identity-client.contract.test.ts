import { describe, expect, it, vi } from "vitest";

import * as teamHubAgentCallbackClient from "../generated/typescript/src/teamhub-internal/client.js";
import {
  createTeamHubAgentIdentityUrl,
  getTeamHubAgentIdentity,
} from "../generated/typescript/src/teamhub-internal/client.js";

describe("TeamHub Agent callback identity client", () => {
  it("builds the active Agent identity URL without retaining base query state", () => {
    expect(
      createTeamHubAgentIdentityUrl(
        "https://teamhub.example.test/root?ignored=true#fragment",
        "agent/with space",
      ),
    ).toBe(
      "https://teamhub.example.test/root/v0/agents/agent%2Fwith%20space/identity",
    );
    expect(() =>
      createTeamHubAgentIdentityUrl("file:///tmp/teamhub", "agent-1"),
    ).toThrow("TeamHub callback base URL must use HTTP or HTTPS");
  });

  it("gets identity with the service Bearer credential", async () => {
    const fetchRequest = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            agent_id: "agent-1",
            actor: {
              id: "actor-1",
              kind: "agent",
              display_name: "Research Agent",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const signal = AbortSignal.timeout(1_000);

    const response = await getTeamHubAgentIdentity({
      baseUrl: "https://teamhub.example.test",
      agentId: "agent-1",
      serviceToken: "service-token",
      fetch: fetchRequest,
      signal,
    });

    expect(response.status).toBe(200);
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://teamhub.example.test/v0/agents/agent-1/identity",
      {
        method: "GET",
        redirect: "error",
        signal,
        headers: { authorization: "Bearer service-token" },
      },
    );
  });

  it("does not expose the retired Agent Artifact writer", () => {
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "createTeamHubAgentArtifactUrl",
    );
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "createTeamHubAgentArtifactVersionUrl",
    );
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "postTeamHubAgentArtifact",
    );
  });

  it("does not expose Run-authenticated Document Revision content", () => {
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "downloadTeamHubDocumentRevisionInput",
    );
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "downloadTeamHubDocumentRevisionAsset",
    );
  });

  it("does not expose the retired Run Artifact reader", () => {
    expect(teamHubAgentCallbackClient).not.toHaveProperty(
      "downloadTeamHubArtifactContent",
    );
  });
});
