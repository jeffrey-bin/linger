import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRunStatus } from "@/features/teamhub/teamhub-types";

import { useRoomMessageRunStatuses } from "./use-room-message-run-statuses";

describe("Room Message Run Status history", () => {
  it("loads Run Statuses for a stable loaded Message scope", async () => {
    const fixture = createTestTeamHubRuntime();
    const listRoomRuntimePresentationRuns = vi
      .fn()
      .mockResolvedValue({ items: [testRunStatus(2)] });
    const runtime = {
      ...fixture,
      client: { ...fixture.client, listRoomRuntimePresentationRuns },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageRunStatuses({
          messageIds: ["message-2", "message-1", "message-2"],
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(listRoomRuntimePresentationRuns).toHaveBeenCalledWith("room-1", [
        "message-1",
        "message-2",
      ]),
    );
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]?.revision).toBe(2);
  });
});

function testRunStatus(revision: number): TeamHubRunStatus {
  return {
    agent: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
    },
    created_at: "2026-08-24T00:00:00Z",
    id: "run-status-1",
    run_id: "run-status-1",
    replied: false,
    revision,
    room_id: "room-1",
    status: "completed",
    updated_at: `2026-08-24T00:00:0${revision}Z`,
  };
}
