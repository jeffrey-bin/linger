import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { MessageActivitiesPanelTab } from "./message-activities-panel-tab";

describe("MessageActivitiesPanelTab", () => {
  it("loads the complete exact Message log", async () => {
    const runtime = createTestTeamHubRuntime();
    const getMessageActivities = vi.fn<TestRouteHandler>(() => ({
      has_native_turn: true,
      provider_kind: "codex",
      records: [
        {
          category: "tool_call",
          native_record: {
            payload: {
              arguments: { room_id: "room-1" },
              call_id: "call-1",
              name: "get_room",
              type: "function_call",
            },
            type: "response_item",
          },
          native_type: "response_item.function_call",
          ordinal: 1,
          redacted_fields: [],
          tool_call_id: "call-1",
          tool_name: "get_room",
          turn_id: "turn-1",
        },
        {
          category: "tool_result",
          native_record: {
            payload: {
              call_id: "call-1",
              output: { content: [{ text: "Room loaded", type: "text" }] },
              type: "function_call_output",
            },
            type: "response_item",
          },
          native_type: "response_item.function_call_output",
          ordinal: 2,
          redacted_fields: [],
          tool_call_id: "call-1",
          tool_name: "get_room",
          turn_id: "turn-1",
        },
      ],
      status: "available",
      truncated: false,
    }));
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}/activities",
      getMessageActivities,
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <MessageActivitiesPanelTab
              hidden={false}
              message={message()}
              roomId="room-1"
              tenantId="tenant-1"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(
      (await screen.findAllByText("Working on the task"))[0],
    ).toBeVisible();
    expect(
      screen.queryByText("Tool result · get_room"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
    expect(screen.queryByText("Open message")).not.toBeInTheDocument();
    expect(screen.queryByText("2 records")).not.toBeInTheDocument();
    expect(getMessageActivities).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { messageId: "message-1", roomId: "room-1" },
      }),
    );
  });

  it("stops polling once the Message log is unavailable", async () => {
    const runtime = createTestTeamHubRuntime();
    const getMessageActivities = vi.fn<TestRouteHandler>(() => ({
      has_native_turn: false,
      provider_kind: "codex",
      reason: "The linked Agent Runtime run is no longer available",
      records: [],
      status: "unavailable",
      truncated: false,
    }));
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}/activities",
      getMessageActivities,
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <MessageActivitiesPanelTab
              hidden={false}
              message={message()}
              roomId="room-1"
              tenantId="tenant-1"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Message activity log unavailable"),
    ).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(getMessageActivities).toHaveBeenCalledTimes(1);
  });

  it("incrementally refreshes the exact Message log while visible", async () => {
    const runtime = createTestTeamHubRuntime();
    const firstRecord = {
      category: "message" as const,
      native_record: {
        payload: { content: "Initial request", role: "user" },
      },
      native_type: "response_item.message",
      ordinal: 1,
      redacted_fields: [],
      role: "user" as const,
      turn_id: "turn-1",
    };
    const incrementalRecord = {
      category: "reasoning" as const,
      native_record: {
        payload: { text: "Checking the latest output" },
        type: "event_msg",
      },
      native_type: "event_msg.agent_reasoning",
      ordinal: 2,
      redacted_fields: [],
      turn_id: "turn-1",
    };
    const response = (
      records:
        | (typeof firstRecord)[]
        | Array<typeof firstRecord | typeof incrementalRecord>,
    ) => ({
      has_native_turn: true,
      provider_kind: "codex",
      records,
      status: "available" as const,
      truncated: false,
    });
    const getMessageActivities = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(response([firstRecord]))
      .mockReturnValue(response([firstRecord, incrementalRecord]));
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}/activities",
      getMessageActivities,
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <MessageActivitiesPanelTab
              hidden={false}
              message={message()}
              roomId="room-1"
              tenantId="tenant-1"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Initial request")).toBeVisible();
    await screen.findByText("Checking the latest output");
    expect(screen.getByText("Checking the latest output")).toBeVisible();
    expect(getMessageActivities.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

function message(): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
      tenant_id: "tenant-1",
    },
    created_at: "2026-09-11T00:00:00Z",
    id: "message-1",
    message_kind: "conversation",
    raw_message: "Done",
    room_id: "room-1",
    segments: [{ content: "Done", type: "text" }],
    tenant_id: "tenant-1",
  };
}
