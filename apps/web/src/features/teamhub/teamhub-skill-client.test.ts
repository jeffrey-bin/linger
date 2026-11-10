import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";
import { createHttpTeamHubClient } from "./teamhub-client";
import { requestUrlText } from "@linger/service-kit";

describe("Agent Skill upload HTTP client", () => {
  it("uploads a Skill package without caller-chosen identity fields", async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.test",
      fetchRequest,
    });
    await client.uploadAgentSkillPackage(
      "tenant",
      "agent",
      new Blob(["---\nname: notes\ndescription: Notes\n---\n"]),
      "SKILL.md",
      "upload-retry-key",
    );
    const [url, init] = (await sentRequests(fetchRequest))[0]!;
    expect(requestUrlText(url)).toBe(
      "https://teamhub.test/v0/tenants/tenant/agents/agent/skill-packages",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("upload-retry-key");
    expect(headers.get("Content-Type")).toMatch(
      /^multipart\/form-data; boundary=/u,
    );
    const [request] = fetchRequest.mock.calls[0]!;
    const form = await (request as Request).formData();
    expect(form.get("package")).toBeInstanceOf(Blob);
  });
});
