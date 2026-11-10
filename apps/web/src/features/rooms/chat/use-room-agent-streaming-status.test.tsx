vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => queryClient,
}));
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRunStatus,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";

import { useRoomAgentStreamingStatus } from "./use-room-agent-streaming-status";

const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

const runStatusState = vi.hoisted(() => ({
  current: [] as TeamHubRunStatus[],
}));
const runStatusCollectionState = vi.hoisted(() => ({ synchronized: true }));
const messageState = vi.hoisted(() => ({
  current: [] as TeamHubMessage[],
}));
const historicalRunStatusState = vi.hoisted(() => ({
  current: [] as TeamHubRunStatus[],
}));
const eventState = vi.hoisted(
  (): {
    current: Record<string, readonly TeamHubRuntimePresentationEventRecord[]>;
  } => ({ current: {} }),
);
const runtimePresentationInputState = vi.hoisted(() => ({
  historyMessageIds: [] as string[],
  observedRunStatuses: [] as TeamHubRunStatus[],
  syncedRunStatuses: [] as TeamHubRunStatus[],
}));

vi.mock("../runtime-status/use-room-run-statuses", () => ({
  useRoomRunStatusCollection: () => ({
    items: runStatusState.current,
    synchronized: runStatusCollectionState.synchronized,
  }),
}));
vi.mock("../runtime-status/use-room-runtime-presentations", () => ({
  useRoomRuntimePresentations: ({
    activeRunStatuses,
    runStatuses,
  }: {
    activeRunStatuses?: TeamHubRunStatus[];
    runStatuses: TeamHubRunStatus[];
  }) => {
    runtimePresentationInputState.observedRunStatuses = runStatuses;
    runtimePresentationInputState.syncedRunStatuses =
      activeRunStatuses ?? runStatuses;
    return {
      eventsByRunStatusId: Object.fromEntries(
        runStatuses.map((runStatus) => [
          runStatus.id,
          eventState.current[runStatus.id] ?? [{ event_ordinal: "1" }],
        ]),
      ),
      progressVersion: "",
    };
  },
}));
vi.mock("../runtime-status/use-room-message-run-statuses", () => ({
  normalizeRuntimePresentationMessageIds: (messageIds: readonly string[]) =>
    [...new Set(messageIds.slice(-100))].sort(),
  useRoomMessageRunStatuses: ({ messageIds }: { messageIds: string[] }) => {
    runtimePresentationInputState.historyMessageIds = messageIds;
    return historicalRunStatusState.current;
  },
}));

describe("Room Agent streaming status", () => {
  afterEach(() => {
    queryClient.invalidateQueries.mockClear();
    runStatusState.current = [];
    runStatusCollectionState.synchronized = true;
    historicalRunStatusState.current = [];
    messageState.current = [];
    eventState.current = {};
    runtimePresentationInputState.historyMessageIds = [];
    runtimePresentationInputState.observedRunStatuses = [];
    runtimePresentationInputState.syncedRunStatuses = [];
  });

  it("keeps a replied Run status active for presentation sync", () => {
    const active = { ...runStatus(agentRef()), replied: true };
    runStatusState.current = [active];
    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: [reply(agentRef())],
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );
    expect(result.current.runStatuses).toEqual([active]);
    expect(runtimePresentationInputState.syncedRunStatuses).toEqual([active]);
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it("retains Run Status history when the first formal reply arrives", () => {
    const agent = agentRef();
    messageState.current = [reply(agent)];
    const { result, rerender } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    runStatusState.current = [runStatus(agent)];
    rerender();

    expect(result.current.runStatuses).toHaveLength(1);
    expect(result.current.runStatuses[0]?.status).toBe("active");
  });

  it("keeps an active Run Status when an anchored Agent card arrives", () => {
    const agent = agentRef();
    messageState.current = [replyCard(agent)];
    eventState.current = { "run-status-1": [outputRecord(1, "message-reply")] };
    runStatusState.current = [runStatus(agent)];
    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toHaveLength(1);
  });

  it("keeps tracking tool activity after an intermediate reply", () => {
    const agent = agentRef();
    runStatusState.current = [runStatus(agent)];
    const { result, rerender } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );
    expect(result.current.runStatuses).toHaveLength(1);

    messageState.current = [reply(agent)];
    rerender();

    expect(result.current.runStatuses).toHaveLength(1);
    expect(result.current.runStatuses[0]?.status).toBe("active");
  });

  it("keeps terminal Runtime presentation history associated with loaded Messages", () => {
    const agent = agentRef();
    messageState.current = [reply(agent)];
    historicalRunStatusState.current = [
      { ...runStatus(agent), revision: 4, status: "completed" },
    ];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual(
      historicalRunStatusState.current,
    );
    expect(
      result.current.runtimePresentationEventsByRunStatusId,
    ).toHaveProperty("run-status-1");
  });

  it.each(["message-first", "event-first"])(
    "does not treat an unanchored MCP output as the end of a Run (%s)",
    (order) => {
      const agent = agentRef();
      runStatusState.current = [runStatus(agent)];
      const { result, rerender } = renderHook(() =>
        useRoomAgentStreamingStatus({
          messages: messageState.current,
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      );
      const publishMessage = () => {
        messageState.current = [
          { ...reply(agent), reply_to_message_id: undefined },
        ];
      };
      const publishEvent = () => {
        eventState.current = {
          "run-status-1": [
            {
              event: {
                type: "presentation.output_created",
                output_id: "message-reply",
                output_kind: "message",
                surface: "room_timeline",
              },
              event_ordinal: "2",
              segment_id: "segment-1",
              message_id: "message-reply",
            },
          ],
        };
      };
      (order === "message-first" ? publishMessage : publishEvent)();
      rerender();
      expect(result.current.runStatuses[0]?.status).toBe("active");
      (order === "message-first" ? publishEvent : publishMessage)();
      rerender();
      expect(result.current.runStatuses[0]?.status).toBe("active");
      expect(
        result.current.runtimePresentationEventsByRunStatusId["run-status-1"],
      ).toHaveLength(1);
    },
  );

  it("keeps a newly aborted Run Status available for failure presentation", () => {
    const agent = agentRef();
    const failedRunStatus = {
      ...runStatus(agent),
      stop_reason: "private provider error",
      replied: false,
      revision: 4,
      status: "aborted" as const,
    };
    runStatusState.current = [failedRunStatus];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual([failedRunStatus]);
  });

  it("scopes history to loaded Messages and eagerly syncs only active Run Statuses", () => {
    const agent = agentRef();
    messageState.current = [
      { ...reply(agent), id: "message-2" },
      { ...reply(agent), id: "message-1" },
      { ...reply(agent), id: "message-2" },
    ];
    runStatusState.current = [runStatus(agent)];
    historicalRunStatusState.current = [
      { ...runStatus(agent), id: "run-status-terminal", status: "completed" },
    ];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(runtimePresentationInputState.historyMessageIds).toEqual([
      "message-1",
      "message-2",
    ]);
    expect(
      runtimePresentationInputState.syncedRunStatuses.map((item) => item.id),
    ).toEqual(["run-status-1"]);
    expect(
      runtimePresentationInputState.observedRunStatuses.map((item) => item.id),
    ).toEqual(["run-status-1", "run-status-terminal"]);
    expect(
      result.current.runStatuses.map((item) => [item.id, item.status]),
    ).toEqual([
      ["run-status-1", "active"],
      ["run-status-terminal", "completed"],
    ]);
  });

  it("continues syncing an active Run Status after the Agent conversation reply is visible", () => {
    const agent = agentRef();
    messageState.current = [reply(agent)];
    runStatusState.current = [runStatus(agent)];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses.map((item) => item.status)).toEqual([
      "active",
    ]);
    expect(runtimePresentationInputState.syncedRunStatuses).toHaveLength(1);
  });

  it("does not revive a cached historical Run Status that is still marked active", () => {
    const agent = agentRef();
    runStatusCollectionState.synchronized = false;
    runStatusState.current = [
      { ...runStatus(agent), id: "run-status-stale-live" },
    ];
    historicalRunStatusState.current = [
      { ...runStatus(agent), id: "run-status-stale-active" },
      { ...runStatus(agent), id: "run-status-terminal", status: "completed" },
    ];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses.map((item) => item.id)).toEqual([
      "run-status-terminal",
    ]);
    expect(runtimePresentationInputState.syncedRunStatuses).toEqual([]);
  });

  it("uses a newer live terminal snapshot for the same Run Status", () => {
    const agent = agentRef();
    const historicalTerminalRunStatus = {
      ...runStatus(agent),
      status: "completed" as const,
    };
    const liveCompletedRunStatus = {
      ...historicalTerminalRunStatus,
      replied: false,
      revision: 2,
      updated_at: "2026-08-14T10:00:02Z",
    };
    historicalRunStatusState.current = [historicalTerminalRunStatus];
    runStatusState.current = [liveCompletedRunStatus];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual([liveCompletedRunStatus]);
  });

  it("does not let a stale live snapshot replace newer terminal history", () => {
    const agent = agentRef();
    const staleLiveRunStatus = runStatus(agent);
    const currentHistoricalRunStatus = {
      ...staleLiveRunStatus,
      replied: false,
      revision: 3,
      status: "completed" as const,
      updated_at: "2026-08-14T10:00:03Z",
    };
    runStatusState.current = [staleLiveRunStatus];
    historicalRunStatusState.current = [currentHistoricalRunStatus];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual([currentHistoricalRunStatus]);
  });

  it("keeps the newest active Run Status when it appears last for the same Agent", () => {
    const agent = agentRef();
    const staleRunStatus = {
      ...runStatus(agent),
      id: "run-status-stale",
      updated_at: "2026-08-14T10:00:01Z",
    };
    const liveRunStatus = {
      ...runStatus(agent),
      created_at: "2026-08-14T10:01:00Z",
      id: "run-status-live",
      updated_at: "2026-08-14T10:01:01Z",
    };
    runStatusState.current = [staleRunStatus, liveRunStatus];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual([liveRunStatus]);
  });

  it("keeps the newest active Run Status when it appears first for the same Agent", () => {
    const agent = agentRef();
    const staleRunStatus = {
      ...runStatus(agent),
      id: "run-status-live-stale",
      updated_at: "2026-08-14T10:00:01Z",
    };
    const currentRunStatus = {
      ...runStatus(agent),
      created_at: "2026-08-14T10:01:00Z",
      id: "run-status-live-current",
      updated_at: "2026-08-14T10:01:01Z",
    };
    runStatusState.current = [currentRunStatus, staleRunStatus];

    const { result } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses).toEqual([currentRunStatus]);
  });

  it("keeps concurrent Agents independent when one live Run Status becomes terminal", () => {
    const codex = agentRef();
    const reviewer = {
      ...agentRef(),
      display_name: "Reviewer",
      id: "agent-reviewer",
    };
    runStatusState.current = [
      runStatus(codex),
      { ...runStatus(reviewer), id: "run-status-reviewer" },
    ];
    const { result, rerender } = renderHook(() =>
      useRoomAgentStreamingStatus({
        messages: messageState.current,
        roomId: "room-1",
        tenantId: "tenant-1",
      }),
    );

    expect(result.current.runStatuses.map((item) => item.agent.id)).toEqual([
      "agent-codex",
      "agent-reviewer",
    ]);

    runStatusState.current = [
      { ...runStatus(codex), status: "completed" },
      { ...runStatus(reviewer), id: "run-status-reviewer", revision: 2 },
    ];
    rerender();

    expect(
      result.current.runStatuses.map((item) => [item.agent.id, item.status]),
    ).toEqual([
      ["agent-codex", "completed"],
      ["agent-reviewer", "active"],
    ]);
    expect(runtimePresentationInputState.syncedRunStatuses).toEqual([
      expect.objectContaining({ id: "run-status-reviewer" }),
    ]);
  });
});

function outputRecord(
  ordinal: number,
  messageId: string,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      output_id: messageId,
      output_kind: "message",
      surface: "room_timeline",
      type: "presentation.output_created",
    },
    event_ordinal: String(ordinal),
    message_id: messageId,
    segment_id: "segment-1",
  };
}

function agentRef() {
  return {
    display_name: "Codex",
    id: "agent-codex",
    kind: "agent" as const,
    tenant_id: "tenant-1",
  };
}

function runStatus(agent: TeamHubRunStatus["agent"]): TeamHubRunStatus {
  return {
    agent,
    created_at: "2026-08-14T10:00:00Z",
    id: "run-status-1",
    run_id: "run-status-1",
    replied: false,
    revision: 1,
    room_id: "room-1",
    status: "active",
    updated_at: "2026-08-14T10:00:01Z",
  };
}

function reply(agent: TeamHubMessage["author"]): TeamHubMessage {
  return {
    attachments: [],
    author: agent,
    created_at: "2026-08-14T10:00:02Z",
    id: "message-reply",
    message_kind: "conversation",
    raw_message: "The task is complete.",
    reply_to_message_id: "message-1",
    room_id: "room-1",
    segments: [{ content: "The task is complete.", type: "text" }],
    tenant_id: "tenant-1",
  };
}

function replyCard(agent: TeamHubMessage["author"]): TeamHubMessage {
  return {
    ...reply(agent),
    card: {
      card_type: "personal_notice",
      decision_id: "coordination-1",
      status: "pending",
      decision_owner: {
        display_name: "Jenny",
        id: "human-jenny",
        kind: "human",
      },
      intent: "decision_requested",
      kind: "room_creation",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      title: "Request to create a collaboration room",
      room_creation: {
        initial_message_segments: [
          { content: "Start the V0 handoff Room.", type: "text" },
        ],
        member_ids: [agent.id],
        name: "v0-handoff",
        origin_room_id: "room-1",
      },
      version: 1,
    },
  };
}
