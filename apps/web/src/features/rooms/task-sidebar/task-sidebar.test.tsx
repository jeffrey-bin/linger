import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import {
  acceptRoomMessages,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import type {
  TeamHubActor,
  TeamHubActorRef,
  TeamHubDocument,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { panelTabKey, type PanelTab } from "./panel-tab-types";
import type { PanelCreateChoice } from "./panel-tab-strip";
import { readPanelSidebarWidth } from "./panel-width";
import { TaskSidebar } from "./task-sidebar";

describe("TaskSidebar", () => {
  it.each([true, false])(
    "resolves file identity independently of the list and respects access (allowed=%s)",
    async (allowed) => {
      const runtime = createDocumentTestRuntime();
      acceptRoomMessages(runtime);

      const file = await seedRoomUpload(runtime, "uncached-voice-transcript", {
        file: new File(["# Transcript of this recording"], "transcript.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      });
      const tab: PanelTab = {
        id: `file:${file.id}`,
        kind: "file",
        documentId: file.id,
        versionId: file.current_version!.id,
        title: file.title,
        lastActivatedAt: 1,
      };
      if (!allowed)
        runtime.server.on("GET", "/v0/documents/{documentId}", () =>
          teamHubErrorResponse(403, "FORBIDDEN", "Access revoked"),
        );
      await act(async () => {
        await import("./adapters/file-panel-tab");
        renderSidebar({
          runtime,
          tenantId: "tenant-northstar",
          roomId: "room-all",
          tabs: [tab],
          activeTabId: tab.id,
          documents: allowed ? [] : [file],
        });
      });
      if (allowed) {
        await waitFor(() =>
          expect(screen.getByTestId(`panel-tab-file-${file.id}`)).toBeVisible(),
        );
        expect(
          screen.queryByText("This file is no longer available"),
        ).not.toBeInTheDocument();
      } else {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The file was removed or you no longer have access.",
        );
        expect(
          screen.queryByTestId(`panel-tab-file-${file.id}`),
        ).not.toBeInTheDocument();
      }
    },
  );

  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        key(index: number) {
          return [...store.keys()][index] ?? null;
        },
        removeItem(key: string) {
          store.delete(key);
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("labels the panel and active tab", () => {
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-b" }),
      tabs: [
        threadTab("msg-a", "Alpha task", 1),
        threadTab("msg-b", "Beta task", 2),
      ],
    });

    expect(
      screen.getByRole("complementary", { name: "Panel sidebar" }),
    ).toBeVisible();
    const tablist = screen.getByRole("tablist", { name: "Panel tabs" });
    expect(
      within(tablist).getByRole("tab", { name: /Beta task/ }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("keeps Thread body free of Room Files", () => {
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    expect(screen.getByLabelText("Reply in Thread")).toBeVisible();
    expect(screen.queryByText("Room Files")).toBeNull();
  });

  it("does not treat a hidden previous peer Agent Info tab as a missing message", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    const tab: PanelTab = {
      actorId: "actor-previous-agent",
      id: panelTabKey("agentInfo", { actorId: "actor-previous-agent" }),
      kind: "agentInfo",
      lastActivatedAt: 1,
      title: "Agent · New Agent",
    };
    renderSidebar({
      activeTabId: tab.id,
      directPeer: codex,
      roomId: "room-all",
      runtime,
      tabs: [tab],
      tenantId: "tenant-northstar",
    });

    expect(screen.queryByText("This message no longer exists")).toBeNull();
    expect(screen.queryByText("Setting up Agent")).toBeNull();
    const info = await screen.findByLabelText("Agent info");
    expect(within(info).queryByRole("button", { name: "Activity" })).toBeNull();
    expect(within(info).getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(within(info).getByRole("tab", { name: "Details" })).toBeVisible();
  });

  it("mounts Message activity inside Agent Info", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    const onAgentInfoActivityChange = vi.fn();
    const infoTab: PanelTab = {
      actorId: "actor-codex",
      anchorMessageId: "msg-a",
      id: panelTabKey("agentInfo", { actorId: "actor-codex" }),
      kind: "agentInfo",
      lastActivatedAt: 1,
      title: "Agent · Codex",
    };
    renderSidebar({
      activeTabId: infoTab.id,
      onAgentInfoActivityChange,
      roomId: "room-all",
      roomMessages: [
        {
          ...message("msg-a", "Agent response"),
          room_id: "room-all",
          tenant_id: "tenant-northstar",
        },
      ],
      runtime,
      tabs: [infoTab],
      tenantId: "tenant-northstar",
    });

    expect(
      await screen.findByRole("tab", { name: /Agent · Codex/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("tab", { name: /Codex activity/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("message-activities-panel")).toBeVisible();
    expect(screen.getByText("Codex activities")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to Agent info" }));
    expect(onAgentInfoActivityChange).toHaveBeenCalledWith("actor-codex");
  });

  it("loads published live activity inside Agent Info before a formal Message exists", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    const infoTab: PanelTab = {
      activityRunStatusId: "run-status-checklist-review",
      actorId: "actor-codex",
      id: panelTabKey("agentInfo", { actorId: "actor-codex" }),
      kind: "agentInfo",
      lastActivatedAt: 1,
      title: "Agent · Codex",
    };
    renderSidebar({
      activeTabId: infoTab.id,
      roomId: "room-all",
      runtime,
      tabs: [infoTab],
      tenantId: "tenant-northstar",
    });

    expect(
      await screen.findByTestId("agent-live-activity-panel"),
    ).toBeVisible();
    expect(
      await screen.findByRole("list", { name: "Activity log" }),
    ).toBeVisible();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.getByText("Review the remaining client risks")).toBeVisible();
    expect(screen.queryByText("Composing a response")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Generating response text"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Searching for information")[0]!).toBeVisible();
    fireEvent.click(screen.getAllByText("Searching for information")[0]!);
    expect(screen.getAllByText("Searching for information")[1]).toBeVisible();
    expect(screen.queryByText("COMMAND")).not.toBeInTheDocument();
    expect(screen.queryByText("Current activity")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Agent info" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("tab", { name: /Codex activity/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Agent · Codex/ })).toBeVisible();
  });

  it.each([true, false])(
    "exits Activity only when its source Thread is closed (linked=%s)",
    async (linked) => {
      const runtime = createDocumentTestRuntime();
      acceptRoomMessages(runtime);
      const source = {
        ...threadTab("msg-a", "Alpha task", 1),
        anchorMessageId: linked ? "msg-a" : undefined,
      };
      const activity: PanelTab = {
        id: "agentInfo:actor-codex",
        kind: "agentInfo",
        actorId: "actor-codex",
        title: "Codex",
        lastActivatedAt: 2,
        activityRunId: "thread-run",
        activityRoomId: "thread-room",
        anchorMessageId: linked ? "msg-a" : undefined,
      };
      const onCloseTab = vi.fn();
      const onAgentInfoActivityChange = vi.fn();
      renderSidebar({
        runtime,
        tenantId: "tenant-northstar",
        roomId: "room-all",
        tabs: [source, activity],
        activeTabId: activity.id,
        onCloseTab,
        onAgentInfoActivityChange,
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Close Alpha task" }),
      );
      if (linked)
        expect(onAgentInfoActivityChange).toHaveBeenCalledWith("actor-codex");
      else expect(onAgentInfoActivityChange).not.toHaveBeenCalled();
      expect(onCloseTab).toHaveBeenCalledWith(source.id);
    },
  );

  it("reads a Thread Activity from its selected Room rather than the parent Room", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);
    const sourceRunStatus = (
      await runtime.client.listRoomRunStatuses("room-all")
    ).items[0]!;
    const listRunStatuses = vi
      .spyOn(runtime.client, "listRoomRuntimePresentationRuns")
      .mockResolvedValue({
        items: [
          {
            ...sourceRunStatus,
            id: "thread-run-status",
            run_id: "thread-run",
            room_id: "thread-room",
            agent: { id: "actor-codex", kind: "agent", display_name: "Codex" },
            status: "completed",
          },
        ],
      });
    const listEvents = vi.fn<TestRouteHandler>(() => ({
      has_more: false,
      items: [],
      published_through_ordinal: "0",
    }));
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
      listEvents,
    );
    const infoTab: PanelTab = {
      activityRunId: "thread-run",
      activityRoomId: "thread-room",
      actorId: "actor-codex",
      id: "agentInfo:actor-codex",
      kind: "agentInfo",
      lastActivatedAt: 1,
      title: "Codex",
    };
    renderSidebar({
      activeTabId: infoTab.id,
      roomId: "room-all",
      runtime,
      tabs: [infoTab],
      tenantId: "tenant-northstar",
    });
    await waitFor(() => expect(listEvents).toHaveBeenCalled());
    expect(listRunStatuses).toHaveBeenCalledWith(
      "thread-room",
      [],
      "thread-run",
    );
    expect(
      listEvents.mock.calls.every(
        ([request]) =>
          request.params.roomId === "thread-room" &&
          request.params.runId === "thread-run-status",
      ),
    ).toBe(true);
  });

  it("loads earlier Thread activity on request", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);
    const list = vi.fn<TestRouteHandler>(({ query }) => ({
      items: [],
      snapshot_room_seq: 1,
      page: query.get("cursor")
        ? { has_more: false }
        : { has_more: true, next_cursor: "older" },
    }));
    runtime.server.on("GET", "/v0/rooms/{roomId}/messages", list);
    const tab: PanelTab = {
      id: "agentActivity:actor-codex",
      kind: "agentActivity",
      actorId: "actor-codex",
      activityRoomId: "thread-room",
      lastActivatedAt: 1,
      title: "Activity · Codex",
    };
    renderSidebar({
      runtime,
      tabs: [tab],
      activeTabId: tab.id,
      roomId: "room-all",
      tenantId: "tenant-northstar",
    });
    expect(
      screen.getByRole("tab", { name: "Activity · Codex" }),
    ).toHaveTextContent("Codex");
    expect(
      screen.getByRole("tab", { name: "Activity · Codex" }),
    ).not.toHaveTextContent("Activity ·");
    fireEvent.click(
      await screen.findByRole("button", { name: "Load earlier activity" }),
    );
    await waitFor(() =>
      expect(
        list.mock.calls.some(
          ([request]) =>
            request.params.roomId === "thread-room" &&
            request.query.get("cursor") === "older",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load earlier activity" }),
      ).toBeNull(),
    );
  });

  it("offers a retry when Thread activity history fails to load", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      vi
        .fn<TestRouteHandler>()
        .mockImplementationOnce(() => {
          throw new Error("offline");
        })
        .mockImplementation(() => ({
          items: [],
          page: { has_more: false },
          snapshot_room_seq: 1,
        })),
    );
    const tab: PanelTab = {
      id: "agentActivity:actor-codex",
      kind: "agentActivity",
      actorId: "actor-codex",
      activityRoomId: "thread-room",
      lastActivatedAt: 1,
      title: "Activity · Codex",
    };
    renderSidebar({
      runtime,
      tabs: [tab],
      activeTabId: tab.id,
      roomId: "room-all",
      tenantId: "tenant-northstar",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Activity history could not be loaded",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByLabelText("Agent activity history"),
    ).toBeVisible();
  });

  it.each([
    ["agentActivity", "thread"],
    ["agentInfo", "thread"],
    ["agentActivity", "parent"],
    ["agentInfo", "parent"],
  ] as const)(
    "shows the published %s reply body from its selected %s Room",
    async (kind, surface) => {
      const runtime = createDocumentTestRuntime();
      acceptRoomMessages(runtime);
      const parentRoomId = "room-all";
      const parentPage = await teamHubData(
        runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
          params: { path: { roomId: parentRoomId } },
        }),
      );
      const sourceReply = parentPage.items.find(
        (item) => item.id === "message-2",
      )!;
      const sourceRunStatus = (
        await runtime.client.listRoomRunStatuses(parentRoomId)
      ).items.find((item) => item.id === "run-status-checklist-review")!;
      const sourceEvents = await teamHubData(
        runtime.client.api.GET(
          "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
          {
            params: {
              path: { roomId: parentRoomId, runId: sourceRunStatus.id },
              query: { after: "0", limit: 200 },
            },
          },
        ),
      );
      const activityRoomId =
        surface === "thread"
          ? (
              await teamHubData(
                runtime.client.api.POST(
                  "/v0/rooms/{roomId}/messages/{messageId}/thread",
                  {
                    params: {
                      path: { roomId: parentRoomId, messageId: sourceReply.id },
                    },
                  },
                ),
              )
            ).room.id
          : parentRoomId;
      const publishedReply =
        surface === "thread"
          ? {
              ...sourceReply,
              id: "published-thread-reply",
              room_id: activityRoomId,
              raw_message:
                "The Thread Agent completed its review and published this reply.",
              segments: [
                {
                  type: "text" as const,
                  content:
                    "The Thread Agent completed its review and published this reply.",
                },
              ],
            }
          : sourceReply;
      const runStatus = {
        ...sourceRunStatus,
        id: "selected-run-status",
        run_id: "selected-run",
        room_id: activityRoomId,
      };
      const records = sourceEvents.items.map((record) =>
        record.event.type === "presentation.output_created"
          ? {
              ...record,
              message_id: publishedReply.id,
              event: { ...record.event, output_id: publishedReply.id },
            }
          : record,
      );
      vi.spyOn(
        runtime.client,
        "listRoomRuntimePresentationRuns",
      ).mockResolvedValue({ items: [runStatus] });
      runtime.server.on(
        "GET",
        "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
        ({ query }) => ({
          has_more: false,
          items: records.filter(
            (record) =>
              BigInt(record.event_ordinal) > BigInt(query.get("after") ?? "0"),
          ),
          published_through_ordinal: sourceEvents.published_through_ordinal,
        }),
      );
      // A second runtime on the same seed answers every other Message read.
      const seeded = createTestTeamHubRuntime(runtime.seed);
      // This Agent output is already persisted in the selected Room. Declare
      // both read boundaries so Activity may reuse history or read its output.
      runtime.server
        .on("GET", "/v0/rooms/{roomId}/messages", ({ params, request }) =>
          surface === "thread" && params.roomId === activityRoomId
            ? {
                items: [publishedReply],
                page: { has_more: false },
                snapshot_room_seq: 1,
              }
            : seeded.server.fetch(request),
        )
        .on(
          "GET",
          "/v0/rooms/{roomId}/messages/{messageId}",
          ({ params, request }) =>
            params.roomId === activityRoomId &&
            params.messageId === publishedReply.id
              ? publishedReply
              : seeded.server.fetch(request),
        );
      if (surface === "thread") {
        expect(
          parentPage.items.some((item) => item.id === publishedReply.id),
        ).toBe(false);
        expect(
          (
            await teamHubData(
              runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
                params: { path: { roomId: activityRoomId } },
              }),
            )
          ).items,
        ).toEqual([publishedReply]);
        expect(publishedReply.author.kind).toBe("agent");
      }
      const tab: PanelTab = {
        id: `${kind}:actor-codex`,
        kind,
        actorId: "actor-codex",
        activityRunId: runStatus.run_id,
        activityRoomId,
        lastActivatedAt: 1,
        title: "Agent · Codex",
      };
      renderSidebar({
        runtime,
        tabs: [tab],
        activeTabId: tab.id,
        tenantId: "tenant-northstar",
        roomId: parentRoomId,
        roomMessages: parentPage.items,
      });
      const activity = await screen.findByTestId("agent-live-activity-panel");
      expect(
        await within(activity).findByText("Review the remaining client risks"),
      ).toBeVisible();
      fireEvent.click(await within(activity).findByText("Prepared a reply"));
      expect(
        await within(activity).findByText(publishedReply.raw_message),
      ).toBeVisible();
    },
  );

  it("lists this Agent's Activity log as Human questions and opens Runtime activity", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    const onAgentActivityChange = vi.fn();
    const infoTab: PanelTab = {
      actorId: "actor-codex",
      id: panelTabKey("agentActivity", { actorId: "actor-codex" }),
      kind: "agentActivity",
      lastActivatedAt: 1,
      title: "Activity · Codex",
    };
    const launchNotes =
      "I moved the launch notes into Shared Documents. @codex, please review the release checklist.";
    const workflowAsk =
      "@codex Please create a task to adapt the Room panel workflow to real runtime status and drafts.";
    renderSidebar({
      activeTabId: infoTab.id,
      onAgentActivityChange,
      roomId: "room-all",
      roomMessages: [
        {
          ...message("message-1", launchNotes),
          author: {
            display_name: "Jenny Bin",
            id: "actor-jenny",
            kind: "human",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-07-23T09:12:00Z",
          room_id: "room-all",
          tenant_id: "tenant-northstar",
        },
        {
          ...message(
            "msg-previous-agent",
            "Got it, I will build a Social Card expert Agent.",
          ),
          author: {
            display_name: "Previous Agent",
            id: "actor-previous-agent",
            kind: "agent",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-07-23T09:13:00Z",
          room_id: "room-all",
          tenant_id: "tenant-northstar",
        },
        {
          ...message(
            "message-2",
            "Reviewed the checklist. The remaining client risks are realtime recovery and attachment publication.",
          ),
          created_at: "2026-07-23T09:14:00Z",
          room_id: "room-all",
          tenant_id: "tenant-northstar",
        },
        {
          ...message("message-workflow-query", workflowAsk),
          author: {
            display_name: "Jenny Bin",
            id: "actor-jenny",
            kind: "human",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-08-12T10:00:00Z",
          room_id: "room-all",
          tenant_id: "tenant-northstar",
        },
      ],
      runtime,
      tabs: [infoTab],
      tenantId: "tenant-northstar",
    });

    const info = await screen.findByLabelText("Codex activity");
    expect(await within(info).findByText(workflowAsk)).toBeVisible();
    expect(within(info).getByText(launchNotes)).toBeVisible();
    expect(
      within(info).queryByText(
        "Got it, I will build a Social Card expert Agent.",
      ),
    ).toBeNull();
    expect(within(info).queryByText(/Reviewed the checklist/)).toBeNull();
    expect(within(info).queryByText("No recent activity")).toBeNull();
    expect(within(info).queryByText(/replies/)).toBeNull();

    fireEvent.click(
      within(info).getByRole("button", {
        name: `View Codex activity: ${workflowAsk}`,
      }),
    );
    expect(onAgentActivityChange).toHaveBeenCalledWith("actor-codex", {
      runStatusId: "run-status-panel-workflow-status",
      activityRoomId: "room-all",
    });

    fireEvent.click(
      within(info).getByRole("button", {
        name: `View Codex activity: ${launchNotes}`,
      }),
    );
    expect(onAgentActivityChange).toHaveBeenCalledWith("actor-codex", {
      runStatusId: "run-status-checklist-review",
      activityRoomId: "room-all",
    });
  });

  it("lists a completed Agent turn from the Human question when Run Statuses are empty", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    const onAgentActivityChange = vi.fn();
    const infoTab: PanelTab = {
      actorId: "actor-codex",
      id: panelTabKey("agentActivity", { actorId: "actor-codex" }),
      kind: "agentActivity",
      lastActivatedAt: 1,
      title: "Activity · Codex",
    };
    const question = "What can you do";
    renderSidebar({
      activeTabId: infoTab.id,
      onAgentActivityChange,
      roomId: "room-all",
      roomMessages: [
        {
          ...message("msg-build", "help me make a social card expert agent"),
          author: {
            display_name: "Jenny Bin",
            id: "actor-jenny",
            kind: "human",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-09-17T09:03:00Z",
        },
        {
          ...message(
            "msg-previous-agent",
            "Got it, I will build a Social Card expert Agent.",
          ),
          author: {
            display_name: "Previous Agent",
            id: "actor-previous-agent",
            kind: "agent",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-09-17T09:04:00Z",
        },
        {
          ...message("msg-ask", question),
          author: {
            display_name: "Jenny Bin",
            id: "actor-jenny",
            kind: "human",
            tenant_id: "tenant-northstar",
          },
          created_at: "2026-09-17T09:31:44Z",
        },
        {
          ...message("msg-agent", "I am a social media card design expert."),
          created_at: "2026-09-17T09:32:09Z",
        },
      ],
      runtime: {
        ...runtime,
        client: {
          ...runtime.client,
          listRoomRuntimePresentationRuns: async () => ({ items: [] }),
        },
      },
      tabs: [infoTab],
      tenantId: "tenant-northstar",
    });

    const info = await screen.findByLabelText("Codex activity");
    expect(within(info).getByText(question)).toBeVisible();
    expect(
      within(info).queryByText(
        "Got it, I will build a Social Card expert Agent.",
      ),
    ).toBeNull();
    expect(
      within(info).queryByText("I am a social media card design expert."),
    ).toBeNull();
    expect(within(info).queryByText("No recent activity")).toBeNull();
  });

  it("paginates a long Activity list without mixing Runtime settings", async () => {
    const runtime = createDocumentTestRuntime();
    acceptRoomMessages(runtime);

    vi.spyOn(
      runtime.client,
      "listRoomRuntimePresentationRuns",
    ).mockResolvedValue({ items: [] });
    const infoTab: PanelTab = {
      actorId: "actor-codex",
      id: panelTabKey("agentActivity", { actorId: "actor-codex" }),
      kind: "agentActivity",
      lastActivatedAt: 1,
      title: "Activity · Codex",
    };
    const messages = Array.from({ length: 13 }, (_, i) => {
      const prompt = {
        ...message(`prompt-${i}`, `Question ${i + 1}`),
        author: {
          display_name: "Jenny",
          id: "actor-jenny",
          kind: "human" as const,
          tenant_id: "tenant-northstar",
        },
        created_at: new Date(Date.UTC(2026, 8, 20, 10, i * 2)).toISOString(),
      };
      return [
        prompt,
        {
          ...message(`answer-${i}`, `Answer ${i + 1}`),
          reply_to_message_id: prompt.id,
          created_at: new Date(
            Date.UTC(2026, 8, 20, 10, i * 2 + 1),
          ).toISOString(),
        },
      ];
    }).flat();
    const onAgentActivityChange = vi.fn();
    renderSidebar({
      runtime,
      roomId: "room-all",
      roomMessages: messages,
      tabs: [infoTab],
      activeTabId: infoTab.id,
      tenantId: "tenant-northstar",
      onAgentActivityChange,
    });
    const info = await screen.findByLabelText("Codex activity");
    expect(
      await within(info).findByText("Recent activity in this conversation"),
    ).toBeVisible();
    expect(
      within(info).getAllByRole("button", { name: /^View Codex activity:/ }),
    ).toHaveLength(10);
    fireEvent.click(within(info).getByRole("button", { name: "Next" }));
    expect(
      within(info).getAllByRole("button", { name: /^View Codex activity:/ }),
    ).toHaveLength(3);
    expect(within(info).queryByRole("button", { name: "Runtime" })).toBeNull();
    expect(within(info).getByText("2 / 2")).toBeVisible();
    expect(
      within(info).queryByRole("textbox", { name: "Search activity" }),
    ).toBeNull();
  });

  it("shows conversation details and the Documents entry when no tabs are open", () => {
    const onCreate = vi.fn();
    renderSidebar({
      activeTabId: null,
      onCreate,
      tabs: [],
    });

    expect(screen.queryByText("No views open")).not.toBeInTheDocument();
    const launcher = screen.getByTestId("panel-launcher");
    expect(
      within(launcher)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Documents", "Collaboration"]);
    expect(screen.queryByRole("button", { name: "Thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Room info" })).toBeNull();
    expect(screen.queryByText("Suggestion")).toBeNull();

    const surface = screen.getByTestId("panel-content-surface");
    expect(surface).toHaveClass("rounded-lg", "rounded-br-2xl", "bg-card");
    expect(
      within(launcher).getByRole("heading", { name: "Conversation details" }),
    ).toBeVisible();
    const documents = screen.getByRole("button", { name: "Documents" });
    expect(
      within(documents).getByText("Browse files shared in this conversation"),
    ).toBeVisible();

    fireEvent.click(documents);
    expect(onCreate).toHaveBeenCalledWith("file");
    expect(screen.queryByRole("button", { name: "Routines" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collaboration" }));
    expect(onCreate).toHaveBeenCalledWith("collaboration");

    fireEvent.click(screen.getByRole("button", { name: "Add panel view" }));
    expect(screen.getByRole("menu", { name: "Add panel view" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Documents" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Routines" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Collaboration" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Room info" })).toBeNull();
  });

  it("reopens the current Agent Info from the empty panel", () => {
    const onAgentInfoActivityChange = vi.fn();
    renderSidebar({
      activeTabId: null,
      tabs: [],
      directPeer: {
        id: "agent-1",
        kind: "agent",
        display_name: "Sinclair",
        tenant_id: "tenant-1",
      },
      onAgentInfoActivityChange,
    });
    const launcher = screen.getByTestId("panel-launcher");
    expect(
      within(launcher).getByText("Sinclair · Settings & activity"),
    ).toBeVisible();
    fireEvent.click(
      within(launcher).getByRole("button", { name: "Agent info" }),
    );
    expect(onAgentInfoActivityChange).toHaveBeenCalledWith("agent-1");
  });

  it("renders Room Info with responsive content from existing Room data", () => {
    const onOpenRoomSettings = vi.fn();
    const offlineAgent: TeamHubActorRef = {
      display_name: "Offline Agent",
      id: "actor-offline",
      kind: "agent",
      tenant_id: "tenant-1",
    };
    const roomInfoTab: PanelTab = {
      id: panelTabKey("roomInfo", {}),
      kind: "roomInfo",
      lastActivatedAt: 1,
      title: "Room info",
    };
    renderSidebar({
      activeTabId: roomInfoTab.id,
      onOpenRoomSettings,
      roomMembers: [codex, offlineAgent],
      tabs: [roomInfoTab],
    });

    expect(screen.getByRole("heading", { name: "Product" })).toBeVisible();
    expect(screen.getByLabelText("2 members")).toBeVisible();
    expect(
      within(screen.getByRole("tablist", { name: "Room info sections" }))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["agents", "files"]);
    expect(screen.getByRole("tab", { name: "agents" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Offline Agent")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Room" }));
    expect(onOpenRoomSettings).toHaveBeenCalledOnce();
  });

  it("opens a safe browser-like URL preview", () => {
    const urlTab: PanelTab = {
      id: panelTabKey("url", {}),
      kind: "url",
      lastActivatedAt: 1,
      title: "URL",
    };
    renderSidebar({ activeTabId: urlTab.id, tabs: [urlTab] });

    expect(screen.queryByRole("link", { name: "Open externally" })).toBeNull();
    expect(screen.getByText("Enter a URL to preview.")).toBeVisible();
    expect(screen.queryByTitle(/^Preview /)).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
    const address = screen.getByRole("textbox", { name: "URL address" });
    fireEvent.change(address, { target: { value: "https://example.com" } });
    fireEvent.submit(address.closest("form")!);
    const frame = screen.getByTitle("Preview https://example.com/");
    expect(frame).toHaveAttribute("sandbox");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(screen.queryByText("Enter a URL to preview.")).toBeNull();
  });

  it("fills the address bar from the requested preview URL", () => {
    const urlTab: PanelTab = {
      id: panelTabKey("url", {}),
      kind: "url",
      lastActivatedAt: 1,
      previewUrl: "https://example.com/docs",
      title: "example.com",
    };
    renderSidebar({ activeTabId: urlTab.id, tabs: [urlTab] });

    expect(screen.getByRole("textbox", { name: "URL address" })).toHaveValue(
      "https://example.com/docs",
    );
    expect(screen.getByTitle("Preview https://example.com/docs")).toBeVisible();
  });

  it("collapses the panel when its last tab closes", () => {
    const onCollapse = vi.fn();
    const onCloseTab = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onCloseTab,
      onCollapse,
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Alpha task" }));
    expect(onCloseTab).toHaveBeenCalledWith(
      panelTabKey("thread", { anchorMessageId: "msg-a" }),
    );
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("keeps the panel open when another tab remains", () => {
    const onCollapse = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onCollapse,
      tabs: [
        threadTab("msg-a", "Alpha task", 1),
        threadTab("msg-b", "Beta task", 2),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Alpha task" }));
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("keeps the strip when the active message is missing", () => {
    const onActiveChange = vi.fn();
    const missingId = panelTabKey("thread", {
      anchorMessageId: "msg-missing",
    });
    render(
      wrapSidebar(
        <TaskSidebar
          accountId="account-1"
          activeTabId={missingId}
          actors={[codexActor]}
          documents={[]}
          lastActivatedAt={{
            [panelTabKey("thread", { anchorMessageId: "msg-a" })]: 1,
            [missingId]: 2,
          }}
          mentionOptions={[codex]}
          onActiveChange={onActiveChange}
          onCloseTab={vi.fn()}
          onCollapse={vi.fn()}
          onCreate={vi.fn()}
          roomId="room-1"
          roomMembers={[codex]}
          roomName="Product"
          tabs={[
            threadTab("msg-a", "Alpha task", 1),
            {
              id: missingId,
              kind: "thread",
              anchorMessageId: "msg-missing",
              title: "msg-missing",
              lastActivatedAt: 2,
            },
          ]}
          taskResolutions={{ "msg-missing": "unavailable" }}
          tasksByMessageId={{ "msg-a": taskFor("msg-a") }}
          tenantId="tenant-1"
        />,
      ),
    );

    expect(screen.getByText("This message no longer exists")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /Alpha task/ }));
    expect(onActiveChange).toHaveBeenCalledWith(
      panelTabKey("thread", { anchorMessageId: "msg-a" }),
    );
  });

  it("mounts at most 3 adapter roots when 5 tabs are open", () => {
    const ids = ["msg-a", "msg-b", "msg-c", "msg-d", "msg-e"] as const;
    const activation = {
      [panelTabKey("thread", { anchorMessageId: "msg-a" })]: 1,
      [panelTabKey("thread", { anchorMessageId: "msg-b" })]: 5,
      [panelTabKey("thread", { anchorMessageId: "msg-c" })]: 10,
      [panelTabKey("thread", { anchorMessageId: "msg-d" })]: 8,
      [panelTabKey("thread", { anchorMessageId: "msg-e" })]: 2,
    };
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-c" }),
      lastActivatedAt: activation,
      tabs: ids.map((id) =>
        threadTab(
          id,
          titles[id] ?? id,
          activation[panelTabKey("thread", { anchorMessageId: id })]!,
        ),
      ),
    });

    expect(screen.getByTestId(`panel-tab-thread-msg-c`)).toBeInTheDocument();
    expect(screen.getByTestId(`panel-tab-thread-msg-d`)).toBeInTheDocument();
    expect(screen.getByTestId(`panel-tab-thread-msg-b`)).toBeInTheDocument();
    expect(
      screen.queryByTestId(`panel-tab-thread-msg-a`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`panel-tab-thread-msg-e`),
    ).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^panel-tab-thread-/)).toHaveLength(3);
    expect(screen.getAllByLabelText("Message Thread")).toHaveLength(1);
  });

  it("creates a Documents collection choice from the create menu", async () => {
    const onCreate = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onCreate,
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    const add = screen.getByRole("button", { name: "Add panel view" });
    add.focus();
    fireEvent.click(add);
    const documents = screen.getByRole("menuitem", { name: "Documents" });
    await waitFor(() => expect(documents).toHaveFocus());
    fireEvent.click(documents);
    expect(onCreate).toHaveBeenCalledWith("file");
    expect(screen.queryByRole("menu", { name: "Add panel view" })).toBeNull();
  });

  it("opens the create menu without replacing the active panel", () => {
    renderSidebar({
      activeTabId: panelTabKey("roomInfo", {}),
      tabs: [
        {
          id: panelTabKey("roomInfo", {}),
          kind: "roomInfo",
          lastActivatedAt: 1,
          title: "Room info",
        },
      ],
    });

    expect(screen.getByRole("heading", { name: "Product" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add panel view" }));

    expect(screen.getByRole("menu", { name: "Add panel view" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Product" })).toBeVisible();
    expect(screen.queryByTestId("panel-launcher")).not.toBeInTheDocument();
  });

  it("returns focus to the active tab when its collection is selected again", async () => {
    const documentsTab: PanelTab = {
      id: panelTabKey("file", {}),
      kind: "file",
      lastActivatedAt: 1,
      title: "Files",
    };
    renderSidebar({ activeTabId: documentsTab.id, tabs: [documentsTab] });

    fireEvent.click(screen.getByRole("button", { name: "Add panel view" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Documents" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus(),
    );
  });

  it("shows a Room Document browser instead of a per-document tab", () => {
    renderSidebar({
      activeTabId: "file:library",
      documents: [
        {
          capabilities: {
            comment: true,
            delete: true,
            duplicate: true,
            export: true,
            manage: true,
            read: true,
            use_as_context: true,
            write: false,
          },
          created_at: "2026-07-23T09:00:00Z",
          creator: codex,
          current_version: {
            id: "doc-1-v1",
            sha256: "a".repeat(64),
            version_number: 1,
          },
          can_edit_native_content: false,
          draft_capability: "none",
          format: "markdown",
          representation_format: "markdown",
          from: [{ binding_kind: "room", context_id: "room-1" }],
          id: "doc-1",
          owner: codex,
          status: "active",
          tenant_id: "tenant-1",
          title: "notes.md",
          updated_at: "2026-07-23T09:00:00Z",
        },
      ],
      tabs: [
        {
          id: "file:library",
          kind: "file",
          title: "Files",
          lastActivatedAt: 1,
        },
      ],
    });

    expect(screen.getByTestId("panel-tab-file-library")).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Room files" }),
    ).toBeVisible();
    const documentButton = screen.getByRole("button", { name: "notes.md" });
    expect(documentButton).toBeVisible();
    expect(
      documentButton.querySelector(".workspace-file-icon"),
    ).toHaveAttribute("data-kind", "code");
    expect(screen.queryByText("Visible in room")).not.toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(
      screen
        .getByTestId("panel-tab-file-library")
        .querySelector('time[datetime="2026-07-23T09:00:00Z"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download notes.md" }),
    ).toBeEnabled();
    const actionsButton = screen.getByRole("button", {
      name: "Actions for notes.md",
    });
    expect(actionsButton).toBeVisible();
    fireEvent.click(actionsButton);
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "All files" })).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Choose a file" }),
    ).not.toBeInTheDocument();
  });

  it("lists Room files newest first", () => {
    function libraryDocument(id: string, title: string, updatedAt: string) {
      return {
        capabilities: {
          comment: true,
          delete: true,
          duplicate: true,
          export: true,
          manage: true,
          read: true,
          use_as_context: true,
          write: false,
        },
        created_at: updatedAt,
        creator: codex,
        current_version: {
          id: `${id}-v1`,
          sha256: "a".repeat(64),
          version_number: 1,
        },
        can_edit_native_content: false,
        draft_capability: "none" as const,
        format: "markdown" as const,
        representation_format: "markdown" as const,
        from: [{ binding_kind: "room" as const, context_id: "room-1" }],
        id,
        owner: codex,
        status: "active" as const,
        tenant_id: "tenant-1",
        title,
        updated_at: updatedAt,
      };
    }

    renderSidebar({
      activeTabId: "file:library",
      documents: [
        libraryDocument("doc-mid", "beta.md", "2026-07-20T09:00:00Z"),
        libraryDocument("doc-old", "alpha.md", "2026-07-14T09:00:00Z"),
        libraryDocument("doc-new", "gamma.md", "2026-07-23T09:00:00Z"),
      ],
      tabs: [
        {
          id: "file:library",
          kind: "file",
          title: "Files",
          lastActivatedAt: 1,
        },
      ],
    });

    const names = [
      ...screen
        .getByRole("navigation", { name: "Room files" })
        .querySelectorAll(".workspace-file-name strong"),
    ].map((name) => name.textContent);
    expect(names).toEqual(["gamma.md", "beta.md", "alpha.md"]);
  });

  it("opens a document from the library without a back-to-all-files control", () => {
    const onOpenDocument = vi.fn();
    renderSidebar({
      activeTabId: "file:library",
      documents: [
        {
          capabilities: {
            comment: true,
            delete: true,
            duplicate: true,
            export: true,
            manage: true,
            read: true,
            use_as_context: true,
            write: false,
          },
          created_at: "2026-07-23T09:00:00Z",
          creator: codex,
          current_version: {
            id: "doc-1-v1",
            sha256: "a".repeat(64),
            version_number: 1,
          },
          can_edit_native_content: false,
          draft_capability: "none",
          format: "markdown",
          representation_format: "markdown",
          from: [{ binding_kind: "room", context_id: "room-1" }],
          id: "doc-1",
          owner: codex,
          status: "active",
          tenant_id: "tenant-1",
          title: "notes.md",
          updated_at: "2026-07-23T09:00:00Z",
        },
      ],
      onOpenDocument,
      tabs: [
        {
          id: "file:library",
          kind: "file",
          title: "Files",
          lastActivatedAt: 1,
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "notes.md" }));
    expect(onOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: "doc-1", title: "notes.md" }),
    );
    expect(screen.queryByRole("button", { name: "All files" })).toBeNull();
    expect(screen.getByTestId("panel-tab-file-library")).toBeVisible();
  });

  it("collapses the panel on Escape when no tabs remain", () => {
    const onCollapse = vi.fn();
    renderSidebar({
      activeTabId: null,
      onCollapse,
      tabs: [],
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCollapse).toHaveBeenCalled();
  });

  it("closes the active tab on Escape without collapsing when tabs remain", () => {
    const onCollapse = vi.fn();
    const onCloseTab = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onCloseTab,
      onCollapse,
      tabs: [
        threadTab("msg-a", "Alpha task", 1),
        threadTab("msg-b", "Beta task", 2),
      ],
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCloseTab).toHaveBeenCalledWith(
      panelTabKey("thread", { anchorMessageId: "msg-a" }),
    );
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("moves the active tab on Cmd+Alt+ArrowRight", () => {
    const onActiveChange = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onActiveChange,
      tabs: [
        threadTab("msg-a", "Alpha task", 1),
        threadTab("msg-b", "Beta task", 2),
        threadTab("msg-c", "Gamma task", 3),
      ],
    });

    fireEvent.keyDown(window, {
      altKey: true,
      key: "ArrowRight",
      metaKey: true,
    });
    expect(onActiveChange).toHaveBeenCalledWith(
      panelTabKey("thread", { anchorMessageId: "msg-b" }),
    );
  });

  it("restores the last closed tab on Cmd+Shift+T", () => {
    const onRestoreClosed = vi.fn();
    const onCloseTab = vi.fn();
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-b" }),
      onCloseTab,
      onRestoreClosed,
      tabs: [
        threadTab("msg-a", "Alpha task", 1),
        threadTab("msg-b", "Beta task", 2),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Close Beta task" }));
    expect(onCloseTab).toHaveBeenCalledWith(
      panelTabKey("thread", { anchorMessageId: "msg-b" }),
    );
    fireEvent.keyDown(window, { key: "t", metaKey: true, shiftKey: true });
    expect(onRestoreClosed).toHaveBeenCalled();
  });

  it("lets the user drag the left edge to resize the sidebar width", () => {
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    const sidebar = screen.getByRole("complementary", {
      name: "Panel sidebar",
    });
    expect(sidebar).toHaveClass("panel-sidebar");
    expect(sidebar).not.toHaveClass("w-full");
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "430px",
    );

    const handle = screen.getByRole("separator", {
      hidden: true,
      name: "Resize sidebar",
    });
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    expect(handle).toHaveAttribute("aria-valuemin", "272");
    expect(handle).toHaveAttribute(
      "aria-valuemax",
      String(Math.max(540, Math.round(window.innerWidth * 0.6))),
    );
    fireEvent.pointerMove(window, { clientX: 940, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 940, pointerId: 1 });

    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "490px",
    );
    expect(readPanelSidebarWidth("account-1")).toBe(490);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "498px",
    );
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "466px",
    );
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 2 });
    const draggedWidth = Number.parseFloat(
      sidebar.style.getPropertyValue("--panel-sidebar-width"),
    );
    expect(draggedWidth).toBeGreaterThanOrEqual(window.innerWidth / 2);
    expect(readPanelSidebarWidth("account-1")).toBe(draggedWidth);

    fireEvent.doubleClick(handle);
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "430px",
    );

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "462px",
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximize sidebar" }));
    expect(sidebar).toHaveAttribute("data-maximized", "true");
    fireEvent.click(screen.getByRole("button", { name: "Restore sidebar" }));
    expect(sidebar.style.getPropertyValue("--panel-sidebar-width")).toBe(
      "462px",
    );
    expect(readPanelSidebarWidth("account-1")).toBe(462);
  });

  it("ends resizing and restores page interaction when the pointer is cancelled", () => {
    renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    const handle = screen.getByRole("separator", {
      hidden: true,
      name: "Resize sidebar",
    });
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("keeps the sidebar mounted until Motion finishes the close animation", async () => {
    const onExitAnimationEnd = vi.fn();
    const { rerender } = renderSidebar({
      activeTabId: panelTabKey("thread", { anchorMessageId: "msg-a" }),
      onExitAnimationEnd,
      open: true,
      tabs: [threadTab("msg-a", "Alpha task", 1)],
    });

    expect(
      screen.getByRole("complementary", { name: "Panel sidebar" }),
    ).toBeInTheDocument();

    rerender(
      wrapSidebar(
        <TaskSidebar
          accountId="account-1"
          activeTabId={panelTabKey("thread", { anchorMessageId: "msg-a" })}
          actors={[codexActor]}
          documents={[]}
          lastActivatedAt={{
            [panelTabKey("thread", { anchorMessageId: "msg-a" })]: 1,
          }}
          mentionOptions={[codex]}
          onActiveChange={vi.fn()}
          onCloseTab={vi.fn()}
          onCollapse={vi.fn()}
          onCreate={vi.fn()}
          onExitAnimationEnd={onExitAnimationEnd}
          onRestoreClosed={vi.fn()}
          open={false}
          roomId="room-1"
          roomMembers={[codex]}
          roomName="Product"
          tabs={[threadTab("msg-a", "Alpha task", 1)]}
          tasksByMessageId={{
            "msg-a": taskFor("msg-a"),
          }}
          tenantId="tenant-1"
        />,
      ),
    );

    await waitFor(() => expect(onExitAnimationEnd).toHaveBeenCalled());
  });
});

function renderSidebar({
  activeTabId,
  documents = [],
  lastActivatedAt,
  onActiveChange = vi.fn(),
  onAgentInfoActivityChange = vi.fn(),
  onAgentActivityChange = vi.fn(),
  onCloseTab = vi.fn(),
  onCollapse = vi.fn(),
  onCreate = vi.fn(),
  onExitAnimationEnd,
  onOpenDocument,
  onOpenRoomSettings,
  onRestoreClosed = vi.fn(),
  open,
  directPeer,
  roomId = "room-1",
  roomMembers = [codex],
  roomMessages,
  runtime = threadTestRuntime(),
  tabs,
  tenantId = "tenant-1",
}: {
  activeTabId: string | null;
  documents?: TeamHubDocument[];
  lastActivatedAt?: Record<string, number>;
  onActiveChange?: (id: string) => void;
  onAgentActivityChange?: (
    actorId: string,
    next?: {
      runStatusId?: string;
      messageId?: string;
      activityRoomId?: string;
    },
  ) => void;
  onAgentInfoActivityChange?: (
    actorId: string,
    next?: { runStatusId?: string; messageId?: string },
  ) => void;
  onCloseTab?: (id: string) => void;
  onCollapse?: () => void;
  onCreate?: (choice: PanelCreateChoice) => void;
  onExitAnimationEnd?: () => void;
  onOpenDocument?: (document: TeamHubDocument) => void;
  onOpenRoomSettings?: () => void;
  onRestoreClosed?: () => void;
  open?: boolean;
  directPeer?: TeamHubActorRef;
  roomId?: string;
  roomMembers?: TeamHubActorRef[];
  roomMessages?: TeamHubMessage[];
  runtime?: ReturnType<typeof createDocumentTestRuntime>;
  tabs: PanelTab[];
  tenantId?: string;
}) {
  const activation =
    lastActivatedAt ??
    Object.fromEntries(tabs.map((tab) => [tab.id, tab.lastActivatedAt]));
  const sidebar = (
    <TaskSidebar
      accountId="account-1"
      activeTabId={activeTabId}
      actors={[codexActor]}
      directPeer={directPeer}
      documents={documents}
      lastActivatedAt={activation}
      mentionOptions={[codex]}
      onActiveChange={onActiveChange}
      onAgentInfoActivityChange={onAgentInfoActivityChange}
      onAgentActivityChange={onAgentActivityChange}
      onCloseTab={onCloseTab}
      onCollapse={onCollapse}
      onCreate={onCreate}
      onExitAnimationEnd={onExitAnimationEnd}
      onOpenDocument={onOpenDocument}
      onOpenRoomSettings={onOpenRoomSettings}
      onRestoreClosed={onRestoreClosed}
      open={open}
      roomId={roomId}
      roomMembers={roomMembers}
      roomMessages={roomMessages}
      roomName="Product"
      tabs={tabs}
      tasksByMessageId={Object.fromEntries(
        tabs
          .map((tab) => tab.anchorMessageId)
          .filter((id): id is string => Boolean(id))
          .map((id) => [id, taskFor(id)]),
      )}
      tenantId={tenantId}
    />
  );

  return render(wrapSidebar(sidebar, runtime));
}

function wrapSidebar(ui: ReactElement, runtime = threadTestRuntime()) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>{ui}</MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
}

function threadTab(
  messageId: string,
  title: string,
  lastActivatedAt: number,
): PanelTab {
  return {
    id: panelTabKey("thread", { anchorMessageId: messageId }),
    kind: "thread",
    anchorMessageId: messageId,
    title,
    lastActivatedAt,
  };
}

const titles: Record<string, string> = {
  "msg-a": "Alpha task",
  "msg-b": "Beta task",
  "msg-c": "Gamma task",
  "msg-d": "Delta task",
  "msg-e": "Epsilon task",
};

function taskFor(id: string) {
  return {
    anchorMessage: message(id, titles[id] ?? id),
  };
}

const codex: TeamHubActorRef = {
  display_name: "Codex",
  id: "actor-codex",
  kind: "agent",
  tenant_id: "tenant-1",
};

const codexActor: TeamHubActor = {
  ...codex,
  created_at: "2026-07-23T10:00:00Z",
};

function message(id: string, body: string): TeamHubMessage {
  return {
    attachments: [],
    author: codex,
    created_at: "2026-07-23T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-1",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-1",
  };
}

// Thread tabs create-or-get their Thread Room as soon as they mount.
function threadTestRuntime() {
  const runtime = createDocumentTestRuntime();
  acceptRoomMessages(runtime);
  return runtime;
}
