import { sha256 } from "@noble/hashes/sha2.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { ServerConnection } from "./server-connection";

function renderConnection(createEnrollment: () => unknown) {
  const runtime = createTestTeamHubRuntime();
  const handler = vi.fn(createEnrollment);
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/local-computer-enrollments",
    handler,
  );
  render(
    <TeamHubRuntimeProvider runtime={runtime}>
      <ServerConnection tenantId="tenant-one" />
    </TeamHubRuntimeProvider>,
  );
  return handler;
}

it("generates a short-lived enrollment token for the selected tenant without exchanging device credentials", async () => {
  const createEnrollment = renderConnection(() => ({
    enrollment_id: "enrollment-one",
    computer_id: "computer-one",
    authorization_code: "a".repeat(43),
    expires_at: "2099-01-01T00:00:00Z",
  }));
  expect(createEnrollment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/Connect a server/));
  fireEvent.change(screen.getByLabelText("Server name"), {
    target: { value: "Example server" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Generate connection token" }),
  );
  const displayed = await screen.findByLabelText("Server connection token");
  const value = JSON.parse(
    atob(
      displayed.textContent
        .split(".")[1]!
        .replaceAll("-", "+")
        .replaceAll("_", "/"),
    ),
  );
  expect(value).toMatchObject({
    origin: window.location.origin,
    tenant_id: "tenant-one",
    computer_id: "computer-one",
    enrollment_id: "enrollment-one",
  });
  expect(value).not.toHaveProperty("gateway_token");
  const challenge = btoa(
    String.fromCharCode(
      ...sha256(new TextEncoder().encode(value.code_verifier)),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(createEnrollment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      params: { tenantId: "tenant-one" },
      body: {
        display_name: "Example server",
        code_challenge: challenge,
        redirect_uri: "http://127.0.0.1:9/callback",
      },
    }),
  );
  expect(
    screen.getByText("linger-computer-local-3000 login --token-stdin"),
  ).toBeVisible();
});

it("does not retry failed issuance automatically or expose raw server errors", async () => {
  const createEnrollment = renderConnection(() =>
    teamHubErrorResponse(500, "INTERNAL", "private credentials"),
  );
  fireEvent.click(screen.getByText(/Connect a server/));
  fireEvent.change(screen.getByLabelText("Server name"), {
    target: { value: "server" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Generate connection token" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Could not generate"),
  );
  expect(createEnrollment).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("private credentials")).toBeNull();
});
