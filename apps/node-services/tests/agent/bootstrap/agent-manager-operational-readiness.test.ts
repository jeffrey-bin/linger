import { describe, expect, it, vi } from "vitest";

import { createAgentManagerOperationalReadiness } from "../../../src/agent/bootstrap/agent-manager-operational-readiness.js";
import { requestUrlText } from "@linger/service-kit";

describe("AgentManager operational readiness", () => {
  it("recovers after the TeamHub becomes ready", async () => {
    let teamhubReady = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = requestUrlText(input);
      if (url === "http://teamhub.test/healthz") {
        return new Response(null, { status: teamhubReady ? 200 : 503 });
      }
      throw new Error(`Unexpected readiness URL ${url}`);
    });
    const readiness = createAgentManagerOperationalReadiness({
      fetch,
      requestTimeoutMs: 500,
      teamHubBaseUrl: "http://teamhub.test",
    });

    await expect(readiness()).resolves.toEqual({
      ready: false,
      reason: "teamhub_unavailable",
    });

    teamhubReady = true;
    await expect(readiness()).resolves.toEqual({ ready: true });
    expect(fetch.mock.calls.map(([input]) => requestUrlText(input))).toEqual([
      "http://teamhub.test/healthz",
      "http://teamhub.test/healthz",
    ]);
  });
});
