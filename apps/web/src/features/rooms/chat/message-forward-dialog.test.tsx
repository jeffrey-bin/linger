import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { MessageForwardDialog } from "./message-forward-dialog";

describe("MessageForwardDialog", () => {
  it("forwards the message to the selected Agent with an idempotency key", async () => {
    const runtime = createTestTeamHubRuntime();
    const message = runtime.seed.messagesByRoom.get("room-all")![0]!;
    const forward = vi.fn<TestRouteHandler>(() => ({ items: [] }));
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/forward",
      forward,
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MessageForwardDialog
          client={runtime.client}
          message={message}
          onClose={onClose}
          tenantId={message.tenant_id}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^Codex/u }));
    fireEvent.click(screen.getByRole("button", { name: /Forward/u }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { target: { id: "actor-codex", kind: "agent" } },
        params: { messageId: message.id, roomId: "room-all" },
      }),
    );
    const [request] = runtime.server.requestsTo(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/forward",
    );
    expect(request?.headers.get("Idempotency-Key")).toBeTruthy();
  });
});
