import {
  showDocument,
  createDocumentTestRuntime,
  seedRoomDocument,
  seedNativeDocument,
  seedRoomUpload,
} from "@/test/document-scenarios";
import {
  acceptRoomCreation,
  acceptRoomMessages,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  teamHubData,
  type TeamHubApiPath,
} from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import {
  type TeamHubRuntime,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubRunStatus,
  TeamHubMessagePage,
} from "@/features/teamhub/teamhub-types";

import {
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomMessagesQueryKey,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  tenantAgentAvailabilityQueryKey,
} from "../room-queries";

import { writeRoomComposerDraft } from "../room-drafts";
import * as documentRoutePreload from "../documents/document-route-preload";
import { RoomChat } from "./room-chat";
import { roomMessageSender } from "./room-message-sender";
import { browserRoomMessageOutbox } from "./room-message-outbox";
import { resolveRoomMessagePresentations } from "./room-message-presentations";

const openPanelTab = vi.fn();

vi.mock("../room-connectivity", async () => {
  const actual = await vi.importActual<typeof import("../room-connectivity")>(
    "../room-connectivity",
  );
  return {
    ...actual,
    // Keep the standalone Chat defaults; only spy panel opens from message entities.
    useRoomOutletContext: () => ({
      focusPanelMessageId: null,
      lastAppliedRoomSeq: 0,
      messagePresentations: {},
      openPanelTab,
      recordMessagePresentation: () => undefined,
      status: "connected" as const,
    }),
  };
});

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createTestStorage(),
  });
});

vi.mock("@/components/read-only-blocknote-document-loader", () => ({
  ReadOnlyBlockNoteDocumentLoader: ({
    ariaLabel,
    markdown,
  }: {
    ariaLabel: string;
    markdown: string;
  }) => (
    <article aria-label={ariaLabel} data-editable="false">
      {markdown
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => (
          <p key={line}>{line.replace(/^#+\s*/, "")}</p>
        ))}
    </article>
  ),
}));

describe("Room Chat", () => {
  beforeEach(async () => {
    openPanelTab.mockReset();
    await browserRoomMessageOutbox.clearAccount("account-jenny");
  });

  it("renders existing messages while the tenant actor directory is pending", async () => {
    const runtime = createTestTeamHubRuntime();

    let releaseActors!: () => void;
    const actorsPending = new Promise<void>((resolve) => {
      releaseActors = resolve;
    });
    const actorsSpy = vi.fn(async () => {
      await actorsPending;
      return { items: runtime.seed.actors, page: { has_more: false } };
    });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/actors", actorsSpy);

    try {
      await act(async () => {
        renderRoomChat(runtime, await loadedRoomChatQueryClient(runtime));
      });
      await waitFor(() => expect(actorsSpy).toHaveBeenCalled());
      await waitFor(() =>
        expect(screen.getByText(/Reviewed the checklist/)).toBeInTheDocument(),
      );
      expect(screen.queryByText("Loading Room")).not.toBeInTheDocument();
    } finally {
      await act(async () => releaseActors());
    }
  });

  it("keeps known delivery mentions while RoomSurface owns attachment tombstones", () => {
    const delegate: TeamHubActorRef = {
      display_name: "Jenny's Delegate",
      id: "actor-delegate",
      kind: "agent",
      tenant_id: "tenant-northstar",
    };
    const deletedMessage: TeamHubMessage = {
      ...message("message-deleted-attachment", "@Jenny's_Delegate"),
      attachments: [
        {
          document_id: "document-1",
          document_version_id: "version-1",
          available: true,
          filename: "report.txt",
          id: "attachment-1",
          media_type: "text/plain",
          sha256: "a".repeat(64),
          size_bytes: 12,
        },
      ],
      segments: [
        {
          content: "@Jenny's_Delegate",
          target: delegate.id,
          target_type: "agent",
          type: "reference",
        },
      ],
    };

    const resolved = resolveRoomMessagePresentations({
      deliveryPresentations: {
        [deletedMessage.id]: {
          attachments: [presentedAttachment(true)],
          mentions: [delegate],
        },
      },
      mentionOptions: [],
      messages: [deletedMessage],
      roomMessagePresentations: {
        [deletedMessage.id]: {
          attachments: [presentedAttachment(false)],
          mentions: [],
        },
      },
    });

    expect(resolved[deletedMessage.id]?.attachments[0]?.available).toBe(false);
    expect(resolved[deletedMessage.id]?.mentions).toEqual([delegate]);
  });

  it("keeps persisted attachments when a Room presentation has none", () => {
    const attachedMessage: TeamHubMessage = {
      ...message("message-agent-file", "Here is the result."),
      attachments: [
        {
          available: true,
          document_id: "document-result",
          document_version_id: "version-result",
          filename: "result.md",
          id: "attachment-result",
          media_type: "text/markdown",
          sha256: "a".repeat(64),
          size_bytes: 801,
        },
      ],
    };

    const resolved = resolveRoomMessagePresentations({
      deliveryPresentations: {},
      mentionOptions: [],
      messages: [attachedMessage],
      roomMessagePresentations: {
        [attachedMessage.id]: { attachments: [], mentions: [] },
      },
    });

    expect(resolved[attachedMessage.id]?.attachments).toMatchObject([
      {
        available: true,
        filename: "result.md",
        mediaType: "text/markdown",
        sizeBytes: 801,
      },
    ]);
  });

  it("keeps a RoomSurface mention when current member options have not refreshed", () => {
    const delegate: TeamHubActorRef = {
      display_name: "Jenny's Delegate",
      id: "actor-delegate",
      kind: "agent",
      tenant_id: "tenant-northstar",
    };
    const mentionedMessage: TeamHubMessage = {
      ...message("message-room-mention", "@Jenny's_Delegate"),
      segments: [
        {
          content: "@Jenny's_Delegate",
          target: delegate.id,
          target_type: "agent",
          type: "reference",
        },
      ],
    };

    const resolved = resolveRoomMessagePresentations({
      deliveryPresentations: {
        [mentionedMessage.id]: { attachments: [], mentions: [] },
      },
      mentionOptions: [],
      messages: [mentionedMessage],
      roomMessagePresentations: {
        [mentionedMessage.id]: {
          attachments: [],
          mentions: [delegate],
        },
      },
    });

    expect(resolved[mentionedMessage.id]?.mentions).toEqual([delegate]);
  });

  it("derives mentions for historical messages without a presentation", () => {
    const delegate: TeamHubActorRef = {
      display_name: "Jenny's Delegate",
      id: "actor-delegate",
      kind: "agent",
      tenant_id: "tenant-northstar",
    };
    const mentionedMessage: TeamHubMessage = {
      ...message("message-historical-mention", "@Jenny's_Delegate"),
      segments: [
        {
          content: "@Jenny's_Delegate",
          target: delegate.id,
          target_type: "agent",
          type: "reference",
        },
      ],
    };

    const resolved = resolveRoomMessagePresentations({
      deliveryPresentations: {},
      mentionOptions: [delegate],
      messages: [mentionedMessage],
      roomMessagePresentations: {},
    });

    expect(resolved[mentionedMessage.id]?.mentions).toEqual([delegate]);
  });

  it("reconciles one sent Message into committed Room history", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const router = createMemoryRouter(
      [
        {
          element: <RoomChat />,
          path: "/t/:tenantId/rooms/:roomId/chat",
        },
      ],
      {
        initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"],
      },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <Suspense fallback={<p>Loading Room</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await screen.findByText(/Reviewed the checklist/);
    fireEvent.change(await screen.findByLabelText("Message Room"), {
      target: { value: "@Codex prepare the V0 handoff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === "P" &&
            element.textContent === "@Codex prepare the V0 handoff",
        ),
      ).toBeVisible(),
    );
  });

  it("offers Voice Mode in a group Room's main composer", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = createMemoryRouter(
      [{ element: <RoomChat />, path: "/t/:tenantId/rooms/:roomId/chat" }],
      { initialEntries: ["/t/tenant-northstar/rooms/room-all/chat"] },
    );

    render(
      <QueryClientProvider client={testQueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <Suspense fallback={<p>Loading Room</p>}>
            <RouterProvider router={router} />
          </Suspense>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    await screen.findByLabelText("Message Room");
    expect(
      await screen.findByRole("button", { name: "Start Voice Mode" }),
    ).toBeInTheDocument();
  });

  it("projects the Room Run Status bootstrap above the composer as an anchored turn status", async () => {
    const runtime = createTestTeamHubRuntime();

    await act(async () => {
      renderRoomChat(runtime, await loadedRoomChatQueryClient(runtime));
    });

    const status = await screen.findByRole("button", {
      name: "Open Agents working activity",
    });
    // The Run's earlier search plays first, then the line rests on its last step.
    await waitFor(
      () => expect(status).toHaveAttribute("title", "Codex: Using tools"),
      { timeout: 3000 },
    );
    expect(
      screen.queryByRole("article", { name: "Live Agent status from Codex" }),
    ).not.toBeInTheDocument();
    const composer = screen.getByLabelText("Message Room");
    const dock = screen.getByTestId("agent-streaming-status-dock");
    expect(
      dock.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The status line opens the Agent's activity directly, with no popover.
    fireEvent.click(status);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(openPanelTab).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "actor-codex",
        kind: "agentActivity",
        title: "Activity · Codex",
      }),
    );
    const opened = openPanelTab.mock.calls.at(-1)?.[0] as {
      activityRunStatusId?: string;
      anchorMessageId?: string;
    };
    expect(opened.activityRunStatusId ?? opened.anchorMessageId).toBeTruthy();
  });

  it("invokes the Direct Room Agent without showing the synthetic Mention", async () => {
    const runtime = createTestTeamHubRuntime();

    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    await screen.findByText(/I can continue the Room V0 implementation/);
    fireEvent.change(await screen.findByLabelText("Message Room"), {
      target: { value: "Continue with the route tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      body: "@Codex Continue with the route tests",
      mentions: [expect.objectContaining({ id: "actor-codex", kind: "agent" })],
      roomId: "room-dm-codex",
    });
    await waitFor(() =>
      expect(screen.getByText("Continue with the route tests")).toBeVisible(),
    );
    expect(
      screen.queryByText("@Codex Continue with the route tests"),
    ).not.toBeInTheDocument();
  });

  it("does not project hardware Capture into a non-AnotherMe Direct Room", async () => {
    const runtime = createTestTeamHubRuntime();

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    await screen.findByText(/I can continue the Room V0 implementation/);
    expect(
      screen.queryByRole("region", { name: "Voice capture" }),
    ).not.toBeInTheDocument();
    cleanup();

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-all/chat",
    );
    await screen.findByText(/Reviewed the checklist/);

    expect(
      screen.queryByRole("region", { name: "Voice capture" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Run a sent message wakes until its pushed Run status ends", async () => {
    const fixture = createTestTeamHubRuntime();
    const createMessage = vi.spyOn(
      roomMessageSender(fixture.client),
      "createMessage",
    );
    let onCollection: ((runs: TeamHubRunStatus[]) => void) | undefined;
    const runtime: TeamHubRuntime = {
      ...fixture,
      runStatuses: {
        subscribe(input) {
          onCollection = input.onCollection;
          input.onCollection([]);
          return () => {
            onCollection = undefined;
          };
        },
      },
    };
    const run: TeamHubRunStatus = {
      agent: { display_name: "Codex", id: "actor-codex", kind: "agent" },
      created_at: "2026-10-20T02:00:00Z",
      id: "run-owed",
      replied: false,
      revision: 0,
      room_id: "room-dm-codex",
      run_id: "run-owed",
      status: "active",
      updated_at: "2026-10-20T02:00:00Z",
    };

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    fireEvent.change(await screen.findByLabelText("Message Room"), {
      target: { value: "Start the V0 review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    // TeamHub queues the Run in the message transaction and pushes its status.
    act(() => onCollection?.([run]));
    expect(
      await screen.findByRole("button", {
        name: "Open Agents working activity",
      }),
    ).toHaveAttribute("title", "Codex: Starting");

    act(() => onCollection?.([{ ...run, revision: 1, status: "completed" }]));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open Agents working activity" }),
      ).toBeNull(),
    );
  });

  it("keeps a deleted Agent DM history visible and replaces the composer with a read-only notice", async () => {
    const fixture = createTestTeamHubRuntime();

    const directRoom = await teamHubData(
      fixture.client.api.GET("/v0/rooms/{roomId}", {
        params: { path: { roomId: "room-dm-codex" } },
      }),
    );
    fixture.server.on("GET", "/v0/rooms/{roomId}", () => ({
      ...directRoom,
      direct_peer_active: false,
    }));

    renderRoomChat(
      fixture,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    expect(
      await screen.findByText(
        "This Agent has been deleted. Message and Run history remain available.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Room timeline").textContent).toContain(
      "I can continue the Room V0 implementation",
    );
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
  });

  it("shows Runtime status for an offline Local Computer", async () => {
    const fixture = createTestTeamHubRuntime();
    const agents = await readTenantAgents(fixture);
    fixture.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      ...agents,
      items: agents.items.map((agent) =>
        agent.actor.id === "actor-codex"
          ? {
              ...agent,
              created_by: { ...agent.created_by, id: "actor-jenny" },
              runtime: {
                ...agent.runtime,
                placement: {
                  type: "local",
                  computer_id: "computer-offline",
                },
              },
            }
          : agent,
      ),
    }));
    const snapshots = await readAgentAvailability(fixture);
    fixture.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      () => ({
        ...snapshots,
        items: snapshots.items.map((item) =>
          item.actor_id === "actor-codex"
            ? {
                ...item,
                availability: {
                  ...item.availability,
                  status: "offline",
                  label: "Offline",
                },
                local_runtime_status: {
                  computer_id: "computer-offline",
                  computer_status: "offline",
                  connection_status: "offline",
                  display_name: "Offline computer",
                  message: "Local Computer is offline",
                  runtime_type: "codex",
                  status: "error",
                  error_code: "LOCAL_COMPUTER_OFFLINE",
                },
              }
            : item,
        ),
      }),
    );
    renderRoomChat(
      fixture,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    expect(await screen.findByText("Local Computer is offline")).toBeVisible();
    expect(screen.getByText("Agent unavailable")).toBeVisible();
    expect(screen.getByLabelText("Message Room")).toBeEnabled();
  });

  it.each([
    ["codex", "Codex", "codex login"],
    ["claude", "Claude Code", "claude auth login"],
  ] as const)(
    "allows messages to an unauthenticated %s Local Agent with recovery guidance",
    async (runtimeType, runtimeName, command) => {
      const fixture = createTestTeamHubRuntime();

      const agents = await readTenantAgents(fixture);
      fixture.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agent-availability",
        () => ({
          items: agents.items.map((agent) => ({
            actor_id: agent.actor.id,
            availability: {
              active_task_count: 0,
              label: "Online",
              status: "online" as const,
            },
            ...(agent.actor.id === "actor-codex"
              ? {
                  local_runtime_status: {
                    computer_id: "computer-jenny-mac",
                    computer_status: "online" as const,
                    display_name: "Jenny's Mac",
                    error_code: "RUNTIME_AUTHENTICATION_REQUIRED" as const,
                    message: "Claude authentication is required",
                    runtime_type: runtimeType,
                    status: "authentication_required" as const,
                    version: "2.1.227",
                  },
                }
              : {}),
          })),
          page: { has_more: false },
        }),
      );

      renderRoomChat(
        fixture,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );

      expect(
        await screen.findByText(`${runtimeName} sign-in required`),
      ).toBeVisible();
      expect(screen.getByText(command)).toBeVisible();
      expect(screen.getByText("Agent unavailable")).toBeVisible();
      expect(screen.getByLabelText("Room timeline").textContent).toContain(
        "I can continue the Room V0 implementation",
      );
      const createMessage = vi.spyOn(
        roomMessageSender(fixture.client),
        "createMessage",
      );
      fireEvent.change(await screen.findByLabelText("Message Room"), {
        target: {
          value: "Save this message while authentication is unavailable",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
      expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
        body: "@Codex Save this message while authentication is unavailable",
        roomId: "room-dm-codex",
      });
      expect(screen.getByText(`${runtimeName} sign-in required`)).toBeVisible();
      expect(
        screen.queryByText(/authentication expired/),
      ).not.toBeInTheDocument();
    },
  );

  it("preserves the DM draft across authentication recovery and diagnostic failures", async () => {
    const fixture = createTestTeamHubRuntime();

    const original = await readAgentAvailability(fixture);
    const availability = (
      status: "ready" | "authentication_required" | "error" | "unknown",
    ) => ({
      ...original,
      items: original.items.map((item) =>
        item.actor_id === "actor-codex"
          ? {
              ...item,
              local_runtime_status: {
                computer_id: "computer-local",
                computer_status:
                  status === "unknown"
                    ? ("unknown" as const)
                    : ("online" as const),
                display_name: "Acceptance server",
                runtime_type: "codex" as const,
                status,
                ...(status === "error"
                  ? { message: "Runtime diagnostic timed out" }
                  : {}),
              },
            }
          : item,
      ),
    });
    const listAvailability = vi.fn(() =>
      availability("authentication_required"),
    );
    fixture.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      listAvailability,
    );
    const queryClient = testQueryClient();
    renderRoomChat(
      fixture,
      queryClient,
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    await screen.findByText("Codex sign-in required");
    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "Keep my unsent draft" } });
    for (const status of [
      "ready",
      "error",
      "unknown",
      "ready",
      "authentication_required",
    ] as const) {
      listAvailability.mockReturnValue(availability(status));
      await act(async () => {
        queryClient.setQueryData(
          tenantAgentAvailabilityQueryKey("tenant-northstar"),
          availability(status),
        );
      });
      expect(screen.getByLabelText("Message Room")).toBe(editor);
      expect(editor).toHaveValue("Keep my unsent draft");
      if (status === "unknown") {
        expect(
          await screen.findByText("Checking Local Computer status…"),
        ).toBeVisible();
        expect(
          screen.getByText("You can keep sending messages."),
        ).toBeVisible();
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled();
        expect(screen.queryByText("Agent unavailable")).not.toBeInTheDocument();
      }
      if (status === "error") {
        expect(
          await screen.findByText("Runtime diagnostic timed out"),
        ).toBeVisible();
        expect(
          screen.queryByText("Codex sign-in required"),
        ).not.toBeInTheDocument();
      }
      if (status === "ready")
        await waitFor(() =>
          expect(
            screen.queryByText("Codex sign-in required"),
          ).not.toBeInTheDocument(),
        );
      if (status === "authentication_required")
        await screen.findByText("Codex sign-in required");
      expect(screen.getByLabelText("Message Room")).toBe(editor);
      expect(editor).toHaveValue("Keep my unsent draft");
    }
  });

  it("keeps the draft and history while the last ready Local Runtime reconnects", async () => {
    const runtime = createTestTeamHubRuntime();

    const original = await readAgentAvailability(runtime);
    const snapshot = {
      ...original,
      items: original.items.map((item) =>
        item.actor_id === "actor-codex"
          ? {
              ...item,
              local_runtime_status: {
                computer_id: "local",
                display_name: "Computer",
                computer_status: "unknown" as const,
                runtime_type: "codex" as const,
                status: "ready" as const,
                connection_status: "reconnecting" as const,
                observed_at: "2026-09-28T01:00:00Z",
              },
            }
          : item,
      ),
    };
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agent-availability",
      () => snapshot,
    );
    const queryClient = testQueryClient();
    renderRoomChat(
      runtime,
      queryClient,
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "Keep this draft" } });
    const notice = await screen.findByText("Reconnecting to Local Computer…");
    expect(notice.closest('[role="status"]')).not.toHaveClass("border-t");
    expect(notice.closest('[role="status"]')).toHaveAttribute(
      "title",
      expect.stringMatching(/^Last confirmed at /),
    );
    expect(screen.queryByText("Agent unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getByLabelText("Room timeline").textContent).toContain(
      "I can continue the Room V0 implementation",
    );
    await act(async () => {
      queryClient.setQueryData(
        tenantAgentAvailabilityQueryKey("tenant-northstar"),
        {
          ...snapshot,
          items: snapshot.items.map((item) =>
            item.local_runtime_status
              ? {
                  ...item,
                  local_runtime_status: {
                    ...item.local_runtime_status,
                    connection_status: "connected",
                    computer_status: "online",
                  },
                }
              : item,
          ),
        },
      );
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Reconnecting to Local Computer…"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Message Room")).toBe(editor);
    expect(editor).toHaveValue("Keep this draft");
  });

  it("focuses the composer once when an Agent DM entry requests it", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
      true,
    );

    const editor = await screen.findByLabelText("Message Room");
    await waitFor(() => expect(editor).toHaveFocus());
    await waitFor(() => expect(router.state.location.state).toBeNull());
  });

  it("renders the declared Message, Mention, and previewable Document response", async () => {
    const runtime = createTestTeamHubRuntime();

    const file = new File(
      ["# Launch Plan\n\nReady for review."],
      "launch-plan.md",
      { type: "text/markdown" },
    );
    const document = await seedRoomUpload(runtime, "launch-plan", {
      file,
      representationFormat: "markdown",
    });
    const composition = roomMessageSender(runtime.client);
    vi.spyOn(composition, "stageAttachment").mockResolvedValue(undefined);
    const result = message("message-declared-attachment", "@Codex");
    result.segments = [
      {
        type: "reference",
        content: "@Codex",
        target: "actor-codex",
        target_type: "agent",
      },
    ];
    const create = vi
      .spyOn(composition, "createMessage")
      .mockResolvedValueOnce({
        message: result,
        presentation: {
          mentions: [
            {
              id: "actor-codex",
              display_name: "Codex",
              kind: "agent",
              tenant_id: "tenant-northstar",
            },
          ],
          attachments: [
            {
              id: document.id,
              document: { id: document.id, title: document.title },
              available: true,
              filename: file.name,
              mediaType: file.type,
              sizeBytes: file.size,
            },
          ],
        },
      });

    const router = renderRoomChat(runtime, testQueryClient());

    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "@Cod" } });
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: {
        files: [
          new File(["# Launch Plan\n\nReady for review."], "launch-plan.md", {
            type: "text/markdown",
          }),
        ],
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "Preview launch-plan.md" }),
        ).toBeVisible(),
      { timeout: 10_000 },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview launch-plan.md" }),
    );
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "file",
          title: "launch-plan.md",
        }),
      ),
    );
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/rooms/room-all/chat",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "@Codex" }));
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith({
        actorId: "actor-codex",
        kind: "agentInfo",
        title: "Agent · Codex",
      }),
    );
    expect(router.state.location.search).toBe("");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-all",
        attachments: [expect.objectContaining({ file: expect.any(File) })],
        mentions: [expect.objectContaining({ id: "actor-codex" })],
      }),
    );
  });

  it("opens the current Document from a historical file card without leaving Chat", async () => {
    const runtime = createTestTeamHubRuntime();

    const document = await seedRoomUpload(
      runtime,
      "room-chat-context-document-1",
      {
        file: new File(["context"], "conversation-context.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      },
    );
    const contextMessage: TeamHubMessage = {
      ...message(
        "message-voice-context",
        "@AnotherMe summarize the discussion so far.",
      ),
      segments: [
        {
          content: "@AnotherMe summarize the discussion so far.\n",
          type: "text",
        },
        {
          content: "conversation-context.md",
          document_id: document.id,
          document_version_id: "historical-version",
          type: "file",
        },
      ],
    };
    const queryClient = testQueryClient();
    const router = renderRoomChat(runtime, queryClient);
    await screen.findByText(/Reviewed the checklist/);
    appendCommittedMessage(queryClient, contextMessage);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Preview conversation-context.md",
      }),
    );

    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith({
        documentId: document.id,
        kind: "file",
        title: "conversation-context.md",
        previewCurrentVersion: true,
      }),
    );
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/rooms/room-all/chat",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a delivered native Document card without pinning a Version", async () => {
    const runtime = createTestTeamHubRuntime();

    const document = seedRoomDocument(runtime, "room-chat-native-card");
    const delivered: TeamHubMessage = {
      ...message("message-native-card", "notes.md"),
      segments: [
        {
          content: "notes.md",
          document_id: document.id,
          presentation: "card",
          type: "document",
        },
      ],
    };
    const queryClient = testQueryClient();
    renderRoomChat(runtime, queryClient);
    await screen.findByText(/Reviewed the checklist/);
    appendCommittedMessage(queryClient, delivered);

    fireEvent.click(
      await screen.findByRole("button", { name: `Open ${document.title}` }),
    );

    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith({
        documentId: document.id,
        kind: "file",
        title: "notes.md",
      }),
    );
  });

  it("warms only the Document surface chunk once a Document card is shown", async () => {
    const preload = vi
      .spyOn(documentRoutePreload, "preloadUnifiedDocumentPage")
      .mockResolvedValue(
        {} as Awaited<
          ReturnType<typeof documentRoutePreload.preloadUnifiedDocumentPage>
        >,
      );
    const runtime = createTestTeamHubRuntime();
    const document = seedRoomDocument(runtime, "room-chat-surface-prefetch");
    const queryClient = testQueryClient();
    renderRoomChat(runtime, queryClient);
    await screen.findByText(/Reviewed the checklist/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preload).not.toHaveBeenCalled();

    appendCommittedMessage(queryClient, {
      ...message("message-surface-prefetch", "notes.md"),
      segments: [
        {
          content: "notes.md",
          document_id: document.id,
          presentation: "card",
          type: "document",
        },
      ],
    });

    await waitFor(() => expect(preload).toHaveBeenCalledOnce());
    preload.mockRestore();
  });

  it("opens Composer Document references by stable unified identity", async () => {
    window.localStorage.clear();
    const runtime = createTestTeamHubRuntime();

    const router = renderRoomChat(runtime, testQueryClient());
    const editor = await screen.findByLabelText("Message Room");

    fireEvent.change(editor, {
      target: { selectionStart: 4, value: "@Cod" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /^Codex/ }));
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.change(editor, {
      target: { selectionStart: 8, value: "@Codex @" },
    });
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("option", { name: /product-v0-brief\.md/i }),
    );

    let composerReferences = screen.getByRole("group", {
      name: "Composer references",
    });
    fireEvent.click(
      within(composerReferences).getByRole("button", {
        name: "Open Codex profile",
      }),
    );
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith({
        actorId: "actor-codex",
        kind: "agentInfo",
        title: "Agent · Codex",
      }),
    );
    expect(router.state.location.search).toBe("");
    composerReferences = screen.getByRole("group", {
      name: "Composer references",
    });

    fireEvent.click(
      within(composerReferences).getByRole("button", {
        name: "Open product-v0-brief.md",
      }),
    );
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith({
        documentId: "document-product-v0-brief",
        kind: "file",
        title: "product-v0-brief.md",
      }),
    );
    expect(router.state.location.pathname).toBe(
      "/t/tenant-northstar/rooms/room-all/chat",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Message Room")).toHaveValue(
      "@Codex @product-v0-brief_md ",
    );
    composerReferences = screen.getByRole("group", {
      name: "Composer references",
    });
    expect(
      within(composerReferences).getByRole("button", {
        name: "Open Codex profile",
      }),
    ).toBeVisible();
    expect(
      within(composerReferences).getByRole("button", {
        name: "Open product-v0-brief.md",
      }),
    ).toBeVisible();
  });

  it("offers only the Wiki Documents the caller owns in the Composer catalog", async () => {
    const runtime = createTestTeamHubRuntime();

    const page = await readShareableDocuments(runtime);
    runtime.server.on("GET", "/v0/library/documents", () => {
      const [sample] = page.items;
      if (!sample) return page;
      return {
        ...page,
        items: [
          ...page.items,
          // TeamHub's shareable view returns these because the Wiki owner can
          // read them, but only a Document's owner may bind it into a Room.
          {
            ...sample,
            capabilities: { ...sample.capabilities, manage: false },
            id: "document-wiki-page",
            title: "Generated Wiki page",
            from: [
              {
                binding_kind: "wiki_page" as const,
                context_id: "wiki-jenny",
                page_key: "projects/plan.md",
              },
            ],
          },
          {
            ...sample,
            capabilities: { ...sample.capabilities, manage: false },
            id: "document-memory-source",
            title: "Memory source file",
            from: [
              {
                binding_kind: "wiki_source" as const,
                context_id: "wiki-jenny",
              },
            ],
          },
          // A file the caller uploaded into their own Wiki is theirs to share.
          {
            ...sample,
            capabilities: { ...sample.capabilities, manage: true },
            id: "document-wiki-upload",
            title: "Café déjà vu",
            from: [
              {
                binding_kind: "wiki_source" as const,
                context_id: "wiki-jenny",
              },
            ],
          },
        ],
      };
    });
    renderRoomChat(runtime, testQueryClient());
    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });

    expect(
      await screen.findByRole("option", { name: /Café déjà vu/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Generated Wiki page/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("option", { name: /Memory source file/ }),
    ).toBeNull();
  });

  it("searches TeamHub for a Document outside the loaded shareable page", async () => {
    const runtime = createTestTeamHubRuntime();

    const document = seedNativeDocument(runtime, "composer-document-search");
    showDocument(runtime, { ...document, title: "Quarterly launch plan" });
    const page = await readShareableDocuments(runtime);
    const list = vi.fn((_request: { query: URLSearchParams }) =>
      // The Document sits past the first page, exactly as it would in a large Tenant.
      ({
        items: page.items.filter((item) => item.id !== document.id),
        page: { has_more: true },
      }),
    );
    runtime.server.on("GET", "/v0/library/documents", list);
    runtime.server.on(
      "PUT",
      "/v0/rooms/{roomId}/documents/{documentId}",
      () => ({
        ...document,
        title: "Quarterly launch plan",
        from: [{ binding_kind: "room", context_id: "room-all" }],
      }),
    );
    const searches = () => queriesTo(runtime, "/v0/library/documents/search");
    renderRoomChat(runtime, testQueryClient());
    const editor = await screen.findByLabelText("Message Room");
    expect(list).not.toHaveBeenCalled();
    expect(searches()).toEqual([]);

    fireEvent.change(editor, {
      target: { selectionStart: 2, value: "@Q" },
    });
    await waitFor(() =>
      expect(
        list.mock.calls.map(([request]) => Object.fromEntries(request.query)),
      ).toContainEqual({ limit: "50", view: "shareable" }),
    );
    // One character only filters the loaded page, as in the search dialog.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(searches()).toEqual([]);

    fireEvent.change(editor, {
      target: { selectionStart: 10, value: "@Quarterly" },
    });
    expect(
      await screen.findByRole("option", { name: /Quarterly launch plan/ }),
    ).toBeVisible();
    expect(list).toHaveBeenCalledTimes(1);
    expect(searches()).toEqual([
      { limit: "20", q: "Quarterly", tenant_id: "tenant-northstar" },
    ]);

    fireEvent.click(
      await screen.findByRole("option", { name: /Quarterly launch plan/ }),
    );

    // The pick survives the catalog dropping the search page once the picker closes.
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("group", { name: "Composer references" }),
        ).getByRole("button", { name: "Open Quarterly launch plan" }),
      ).toBeVisible(),
    );
  });

  it("keeps a restored draft Document reference outside the loaded page", async () => {
    const runtime = createTestTeamHubRuntime();

    const identity = runtime.seed.identity;
    const document = seedNativeDocument(runtime, "composer-draft-document");
    const page = await readShareableDocuments(runtime);
    runtime.server.on("GET", "/v0/library/documents", () => ({
      items: page.items.filter((item) => item.id !== document.id),
      page: { has_more: true },
    }));
    writeRoomComposerDraft(
      {
        accountId: identity.account.id,
        roomId: "room-all",
        tenantId: "tenant-northstar",
      },
      {
        body: "@untitled please review",
        documentContexts: [],
        documentReferences: [{ documentId: document.id, token: "@untitled" }],
        mentions: [],
        skillReferences: [],
      },
    );
    renderRoomChat(runtime, testQueryClient());

    await waitFor(() =>
      expect(
        within(
          screen.getByRole("group", { name: "Composer references" }),
        ).getByRole("button", { name: `Open ${document.title}` }),
      ).toBeVisible(),
    );
  });

  it.each([false, true])(
    "finds a personal Document in another Room and gates sending on binding (failure=%s)",
    async (failBinding) => {
      const runtime = createTestTeamHubRuntime();

      const document = seedNativeDocument(runtime, "cross-room-doc-picker");
      const bind = vi.fn(() =>
        failBinding
          ? teamHubErrorResponse(403, "FORBIDDEN", "Access revoked")
          : {
              ...document,
              from: [{ binding_kind: "room", context_id: "room-all" }],
            },
      );
      runtime.server.on(
        "PUT",
        "/v0/rooms/{roomId}/documents/{documentId}",
        bind,
      );
      const lists = () => queriesTo(runtime, "/v0/library/documents");
      renderRoomChat(runtime, testQueryClient());
      const editor = await screen.findByLabelText("Message Room");
      expect(lists()).toEqual([]);
      expect(bind).not.toHaveBeenCalled();
      fireEvent.change(editor, {
        target: { value: "@untit", selectionStart: 6 },
      });
      await waitFor(() =>
        expect(lists()).toContainEqual(
          expect.objectContaining({ view: "shareable" }),
        ),
      );
      fireEvent.click(await screen.findByRole("option", { name: /untitled/i }));
      await waitFor(() =>
        expect(bind).toHaveBeenCalledWith(
          expect.objectContaining({
            params: { documentId: document.id, roomId: "room-all" },
          }),
        ),
      );
      if (failBinding) {
        expect(
          await screen.findByText(/Document could not be shared/),
        ).toBeVisible();
        expect(editor).toHaveValue("@untit");
        return;
      }
      await waitFor(() =>
        expect(
          within(
            screen.getByRole("group", { name: "Composer references" }),
          ).getByRole("button", { name: `Open ${document.title}` }),
        ).toBeVisible(),
      );
      fireEvent.keyDown(editor, { key: "Enter" });
      await waitFor(async () =>
        expect(
          (await listRoomMessages(runtime, "room-all")).items.at(-1)?.segments,
        ).toContainEqual(
          expect.objectContaining({
            type: "document",
            document_id: document.id,
          }),
        ),
      );
    },
  );

  it.each(["human", "agent"] as const)(
    "sends a pasted %s-owned Document URL without binding before send",
    async (ownerKind) => {
      const runtime = createTestTeamHubRuntime();

      const document = seedNativeDocument(
        runtime,
        "room-chat-pasted-document-autobind",
      );
      const bindDocument = vi.fn(() =>
        teamHubErrorResponse(404, "NOT_FOUND", "Document was not found."),
      );
      runtime.server.on(
        "PUT",
        "/v0/rooms/{roomId}/documents/{documentId}",
        bindDocument,
      );
      if (ownerKind === "agent") {
        runtime.server.on("GET", "/v0/documents/{documentId}", () => ({
          ...document,
          capabilities: {
            ...document.capabilities,
            manage: false,
            delete: false,
          },
          owner: { ...document.owner, id: "actor-codex", kind: "agent" },
        }));
      }
      const createMessage = vi.spyOn(
        roomMessageSender(runtime.client),
        "createMessage",
      );
      const listDocuments = () =>
        runtime.server.requestsTo("GET", "/v0/rooms/{roomId}/documents");
      const router = renderRoomChat(runtime, testQueryClient());
      const editor = await screen.findByLabelText("Message Room");
      await waitFor(() => expect(listDocuments().length).toBeGreaterThan(0));
      const initialDocumentLoads = listDocuments().length;

      fireEvent.paste(editor, {
        clipboardData: {
          getData: () =>
            `${window.location.origin}/t/tenant-northstar/documents/${document.id}`,
        },
      });
      expect(
        await within(
          screen.getByRole("group", { name: "Composer references" }),
        ).findByRole("button", { name: `Open ${document.title}` }),
      ).toBeVisible();
      expect(bindDocument).not.toHaveBeenCalled();
      expect(createMessage).not.toHaveBeenCalled();
      expect(listDocuments()).toHaveLength(initialDocumentLoads);

      fireEvent.keyDown(editor, { key: "Enter" });
      await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(listDocuments().length).toBeGreaterThan(initialDocumentLoads),
      );
      expect(bindDocument).not.toHaveBeenCalled();
      await waitFor(async () => {
        const messages = await listRoomMessages(runtime, "room-all");
        expect(messages.items.at(-1)?.segments).toContainEqual(
          expect.objectContaining({
            document_id: document.id,
            type: "document",
          }),
        );
      });
      let sentMention: HTMLElement | undefined;
      await waitFor(() => {
        sentMention = screen
          .getAllByRole("button", { name: `Open ${document.title}` })
          .find((button) => button.closest("[data-message-id]"));
        expect(sentMention).toBeDefined();
      });
      expect(sentMention).toHaveAttribute("data-reference-kind", "document");

      fireEvent.click(sentMention!);
      await waitFor(() =>
        expect(openPanelTab).toHaveBeenCalledWith({
          documentId: document.id,
          kind: "file",
          title: document.title,
        }),
      );
      expect(router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-all/chat",
      );
    },
  );

  it("keeps a cross-Tenant Document URL out of the current Room Context", async () => {
    const runtime = createTestTeamHubRuntime();

    renderRoomChat(runtime, testQueryClient());
    const editor = await screen.findByLabelText("Message Room");
    await waitFor(() =>
      expect(
        runtime.server.requestsTo("GET", "/v0/rooms/{roomId}/documents").length,
      ).toBeGreaterThan(0),
    );
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: () =>
          `${window.location.origin}/t/tenant-other/documents/document-private`,
      },
    });
    act(() => {
      editor.dispatchEvent(paste);
    });

    expect(paste.defaultPrevented).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document cannot be shared in this Room.",
    );
    expect(
      runtime.server.requestsTo(
        "PUT",
        "/v0/rooms/{roomId}/documents/{documentId}",
      ),
    ).toHaveLength(0);
    expect(
      within(
        screen.getByRole("group", { name: "Composer references" }),
      ).queryByRole("button", { name: /Open/ }),
    ).toBeNull();
  });

  it("loads a linked source Message even when it is outside recent history", async () => {
    const runtime = createTestTeamHubRuntime();

    const sourceMessage = message(
      "message-source",
      "This exact Message published the selected File.",
    );
    const getMessage = vi.fn<TestRouteHandler>(() => sourceMessage);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}",
      getMessage,
    );

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-all/chat?message=message-source",
    );

    await screen.findByRole("region", {
      name: "Linked source Message",
    });
    await screen.findByText("This exact Message published the selected File.");
    const linkedSource = screen.getByRole("region", {
      name: "Linked source Message",
    });
    await waitFor(() =>
      expect(
        within(linkedSource).getByText(
          "This exact Message published the selected File.",
        ),
      ).toBeVisible(),
    );
    expect(
      within(linkedSource).getByRole("button", { name: "Copy message" }),
    ).toBeVisible();
    fireEvent.click(
      within(linkedSource).getByRole("button", {
        name: "More message actions",
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Reply to message",
      }),
    );
    const selectedContext = screen.getByLabelText("Selected reply context");
    expect(selectedContext).toHaveTextContent(
      "This exact Message published the selected File.",
    );

    fireEvent.click(
      within(linkedSource).getByRole("button", {
        name: "More message actions",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to message" }));
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Message Room").value,
    ).toContain("@Codex");
    fireEvent.click(
      within(selectedContext).getByRole("button", {
        name: "Remove Codex from reply context",
      }),
    );
    expect(getMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { messageId: "message-source", roomId: "room-all" },
      }),
    );
    cleanup();
  });

  it("positions an independently loaded linked source without changing recent history", async () => {
    const runtime = createTestTeamHubRuntime();

    const queryClient = testQueryClient();
    const source = message("message-source", "Independently loaded source.");
    let resolveSource!: (value: TeamHubMessage) => void;
    const sourceRequest = new Promise<TeamHubMessage>((resolve) => {
      resolveSource = resolve;
    });
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}",
      () => sourceRequest,
    );
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(200);
    const positioned: string[] = [];
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.messageId === source.id) {
          positioned.push(source.id);
          const timeline = this.closest<HTMLElement>(
            '[aria-label="Room timeline"]',
          );
          timeline!.scrollTop = 400;
        }
      });
    try {
      renderRoomChat(
        runtime,
        queryClient,
        "/t/tenant-northstar/rooms/room-all/chat?message=message-source",
      );
      await screen.findByText(/Reviewed the checklist/);
      const key = roomMessagesQueryKey("tenant-northstar", "room-all");
      const recentHistory =
        queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(key);
      expect(recentHistory).toBeDefined();
      expect(positioned).toEqual([]);
      await act(async () => resolveSource(source));
      await screen.findByText(source.raw_message);
      await waitFor(() => expect(positioned).toEqual([source.id]));
      expect(queryClient.getQueryData(key)).toBe(recentHistory);

      const timeline = screen.getByLabelText("Room timeline");
      timeline.scrollTop = 150;
      fireEvent.scroll(timeline);
      appendCommittedMessage(
        queryClient,
        message("message-after-link", "A later message."),
      );
      await screen.findByText("A later message.");
      expect(positioned).toEqual([source.id]);
      expect(timeline.scrollTop).toBe(150);
    } finally {
      resolveSource(source);
      scrollIntoView.mockRestore();
      vi.restoreAllMocks();
      cleanup();
      queryClient.clear();
    }
  });

  it("scrolls to a linked Message in the timeline instead of pinning a source card", async () => {
    const runtime = createTestTeamHubRuntime();

    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-all/chat?message=message-2",
      );

      await screen.findByText(/Reviewed the checklist/);
      const target = screen
        .getAllByRole("article")
        .find((article) =>
          article.textContent?.includes("Reviewed the checklist"),
        );
      expect(target).toBeDefined();
      expect(
        screen.queryByRole("region", { name: "Linked source Message" }),
      ).not.toBeInTheDocument();
      expect(target).toHaveAttribute("data-message-id", "message-2");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("keeps a linked source Message visible above a long timeline", async () => {
    const runtime = createTestTeamHubRuntime();

    runtime.server.on("GET", "/v0/rooms/{roomId}/messages/{messageId}", () =>
      message("message-source", "This source Message must remain visible."),
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "clientHeight",
    );
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1_000,
    });

    try {
      renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-all/chat?message=message-source",
      );

      await screen.findByText("This source Message must remain visible.");
      expect(screen.getByLabelText("Room timeline").scrollTop).toBe(0);
    } finally {
      restoreProperty(
        HTMLDivElement.prototype,
        "clientHeight",
        originalClientHeight,
      );
      restoreProperty(
        HTMLDivElement.prototype,
        "scrollHeight",
        originalScrollHeight,
      );
    }
  });

  it("retries the accepted contextual composition without restoring it over the next draft", async () => {
    const runtime = createTestTeamHubRuntime();

    const retryDocument = await seedRoomUpload(runtime, "retry", {
      file: new File(["retry"], "retry.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const committed = {
      ...message("retry-declared", "Retry with the selected context"),
      attachments: [
        {
          document_id: retryDocument.id,
          document_version_id: retryDocument.current_version!.id,
          available: true,
          filename: "retry.txt",
          id: "retry-attachment",
          media_type: "text/plain",
          sha256: retryDocument.current_version!.sha256,
          size_bytes: 5,
        },
      ],
    };
    const composition = roomMessageSender(runtime.client);
    vi.spyOn(composition, "stageAttachment").mockResolvedValue(undefined);
    const createMessage = vi
      .spyOn(composition, "createMessage")
      .mockRejectedValueOnce(
        new TeamHubError({
          code: "ATTACHMENT_STAGING_FAILED",
          message: "Fixture staging failed.",
          status: 400,
        }),
      )
      .mockResolvedValueOnce({
        message: committed,
        presentation: {
          attachments: [
            {
              id: "retry-attachment",
              document: { id: retryDocument.id, title: "retry.txt" },
              available: true,
              filename: "retry.txt",
              mediaType: "text/plain",
              sizeBytes: 5,
            },
          ],
          mentions: [],
        },
      });

    renderRoomChat(runtime, testQueryClient());

    await screen.findByLabelText("Message Room");
    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "More message actions",
        })
      )[0]!,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reply to message" }),
    );
    expect(screen.getByLabelText("Selected reply context")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Message Room"), {
      target: { value: "Retry with the selected context" },
    });
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: {
        files: [new File(["retry"], "retry.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      (await screen.findAllByText("Fixture staging failed."))[0],
    ).toBeVisible();
    expect(screen.queryByLabelText("Selected reply context")).toBeNull();
    expect(screen.getByLabelText("Message Room")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Message Room"), {
      target: { value: "Newer draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("retry.txt")).toBeVisible());
    await waitFor(() =>
      expect(screen.queryByLabelText("Selected reply context")).toBeNull(),
    );
    expect(screen.getByLabelText("Message Room")).toHaveValue("Newer draft");
    expect(createMessage.mock.calls[0]?.[0].idempotencyKey).toBe(
      createMessage.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(createMessage.mock.calls[1]?.[0].contextMessageIds).toEqual(
      createMessage.mock.calls[0]?.[0].contextMessageIds,
    );
  });

  it("adds dropped files to the current Room composer and sends them there", async () => {
    const runtime = createTestTeamHubRuntime();

    const composition = roomMessageSender(runtime.client);
    vi.spyOn(composition, "stageAttachment").mockResolvedValue(undefined);
    const createMessage = vi
      .spyOn(composition, "createMessage")
      .mockResolvedValueOnce({
        message: message("dropped-declared", ""),
        presentation: { attachments: [], mentions: [] },
      });
    renderRoomChat(runtime, testQueryClient());

    await screen.findByLabelText("Message Room");
    const target = screen.getByTestId("room-chat-file-drop-target");
    const file = new File(["dropped"], "dropped-plan.txt", {
      type: "text/plain",
    });
    const dataTransfer = {
      dropEffect: "none",
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.dragEnter(target, { dataTransfer });
    expect(
      screen.getByText("Release to add to the current message"),
    ).toBeVisible();
    fireEvent.drop(target, { dataTransfer });
    expect(screen.getByText("dropped-plan.txt")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(
      createMessage.mock.calls
        .at(-1)?.[0]
        .attachments.map((attachment) => attachment.file),
    ).toEqual([file]);
  });

  it("keeps attachment upload in the composer and removes upload controls from the outgoing Message", async () => {
    const runtime = createTestTeamHubRuntime();

    vi.spyOn(
      roomMessageSender(runtime.client),
      "stageAttachment",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    ).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          );
        }),
    );

    renderRoomChat(runtime, testQueryClient());

    await screen.findByLabelText("Message Room");
    fireEvent.change(screen.getByLabelText("Choose message attachments"), {
      target: {
        files: [new File(["cancel"], "cancel.txt", { type: "text/plain" })],
      },
    });
    expect(
      screen.getByRole("status", { name: "Uploading cancel.txt" }),
    ).toBeVisible();
    expect(screen.queryByText("Sending...")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("cancel.txt")).toBeVisible();
    // The status line appears only once the send has taken a moment.
    expect(screen.queryByText("Sending...")).toBeNull();
    expect(
      await screen.findByText("Sending...", undefined, { timeout: 2000 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel upload" })).toBeNull();
  });

  it("keeps a lost command response unknown and retries the same intent", async () => {
    const runtime = createTestTeamHubRuntime();

    const composition = roomMessageSender(runtime.client);
    const originalCreateMessage = composition.createMessage.bind(composition);
    const createMessage = vi
      .spyOn(composition, "createMessage")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(originalCreateMessage);

    renderRoomChat(runtime, testQueryClient());

    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { value: "Ambiguous delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Delivery status unknown")).toBeVisible();
    expect(
      screen.getByText(/did not confirm whether this Message was committed/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    expect(createMessage.mock.calls[0]?.[0].idempotencyKey).toBe(
      createMessage.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("offers Copy and the same Thread action on every committed Message", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = renderRoomChat(runtime, testQueryClient());

    await screen.findByText(/Reviewed the checklist/);
    const activeRunMessage = screen
      .getAllByRole("article")
      .find((article) =>
        article.textContent?.includes("Reviewed the checklist"),
      );
    expect(activeRunMessage).toBeDefined();
    const copyButtons = screen.getAllByRole("button", {
      name: "Copy message",
    });
    const threadButtons = screen.getAllByRole("button", {
      name: "More message actions",
    });
    expect(
      screen.queryByRole("button", { name: "Reply to thread" }),
    ).toBeNull();
    expect(copyButtons.length).toBeGreaterThanOrEqual(4);
    expect(threadButtons.length).toBeGreaterThanOrEqual(4);

    fireEvent.click(
      within(activeRunMessage!).getByRole("button", {
        name: "More message actions",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    await waitFor(() =>
      expect(
        runtime.server
          .requestsTo("POST", "/v0/rooms/{roomId}/messages/{messageId}/thread")
          .map((request) => new URL(request.url).pathname),
      ).toContain("/v0/rooms/room-all/messages/message-2/thread"),
    );
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorMessageId: "message-2",
          kind: "thread",
        }),
      ),
    );
    expect(router.state.location.search).toBe("");
    openPanelTab.mockClear();

    const ordinaryMessage = screen
      .getByText(/Keep the first release focused/)
      .closest("article")!;
    fireEvent.click(
      within(ordinaryMessage).getByRole("button", {
        name: "More message actions",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorMessageId: "message-4",
          kind: "thread",
        }),
      ),
    );
    expect(router.state.location.search).toBe("");
  });

  it("keeps Human avatars static while names mention and Agent avatars open Agent info", async () => {
    const runtime = createTestTeamHubRuntime();

    const router = renderRoomChat(runtime, testQueryClient());

    await screen.findByText(/I moved the launch notes/);
    const mayaMessage = screen
      .getAllByRole("article")
      .find((article) =>
        article.textContent?.includes("I moved the launch notes"),
      );
    expect(mayaMessage).toBeDefined();
    fireEvent.click(
      within(mayaMessage!).getByRole("button", { name: "Maya Chen" }),
    );
    expect(screen.getByRole("textbox", { name: "Message Room" })).toHaveValue(
      "@Maya Chen ",
    );
    expect(router.state.location.search).toBe("");

    const avatar = within(mayaMessage!).getByRole("img", {
      name: "Maya Chen avatar",
    });
    expect(avatar.closest("button, a, [role=button]")).toBeNull();
    fireEvent.click(avatar);
    expect(router.state.location.search).toBe("");
    expect(
      within(mayaMessage!).queryByRole("button", {
        name: "Open Maya Chen profile",
      }),
    ).toBeNull();

    fireEvent.click(
      within(mayaMessage!).getByRole("button", {
        name: "More message actions",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "thread",
        }),
      ),
    );
    expect(router.state.location.search).toBe("");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Open Codex status" })[0]!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
    await waitFor(() =>
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "agentActivity",
          actorId: "actor-codex",
          title: "Activity · Codex",
        }),
      ),
    );
    expect(router.state.location.search).toBe("");
  });

  it("keeps local Thread inspection available in live mode", async () => {
    const fixture = createTestTeamHubRuntime();

    const runtime: TeamHubRuntime = {
      client: fixture.client,
      runStatuses: fixture.runStatuses,
      events: fixture.events,
    };

    renderRoomChat(runtime, testQueryClient());

    await screen.findByText(/Reviewed the checklist/);
    expect(
      screen.getAllByRole("button", { name: "More message actions" }).length,
    ).toBeGreaterThanOrEqual(4);
    expect(screen.queryByLabelText("Agent Run")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Lev8 GTM publication review"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Files view/)).not.toBeInTheDocument();

    const editor = screen.getByLabelText("Message Room");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    expect(screen.getByRole("option", { name: /Jenny Bin/ })).toBeVisible();
    expect(await screen.findByRole("option", { name: /Codex/ })).toBeVisible();
  });

  it("does not offer Humans or Agents who are not Room members", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomCreation(runtime);

    const room = await teamHubData(
      runtime.client.api.POST("/v0/tenants/{tenantId}/rooms", {
        params: { path: { tenantId: "tenant-northstar" } },
        body: { name: "Private planning" },
      }),
    );

    renderRoomChat(
      runtime,
      testQueryClient(),
      `/t/tenant-northstar/rooms/${room.id}/chat`,
    );

    const editor = await screen.findByLabelText("Message Room");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });

    expect(
      await screen.findByRole("option", { name: /Jenny Bin/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Maya Chen/ })).toBeNull();
    expect(
      screen.queryByRole("option", { name: /Jenny's Delegate/ }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
    expect(screen.queryByText("Adds to Room")).not.toBeInTheDocument();
  });

  it("keeps Room composition available when the Agent directory fails", async () => {
    const runtime = createTestTeamHubRuntime();

    const listTenantAgents = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          500,
          "AGENT_DIRECTORY_UNAVAILABLE",
          "Directory unavailable.",
        ),
      )
      .mockReturnValue({ items: [], page: { has_more: false } });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", listTenantAgents);
    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );

    renderRoomChat(runtime, testQueryClient());

    const editor = await screen.findByLabelText("Message Room");
    expect(
      await screen.findByText("Your agents are unavailable"),
    ).toBeVisible();
    fireEvent.change(editor, { target: { selectionStart: 4, value: "@Cod" } });
    expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
    fireEvent.change(editor, { target: { value: "Still deliver this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listTenantAgents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Your agents are unavailable"),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(["pending", "failed"])(
    "allows typing with an active peer while the Agent directory is %s",
    async (directoryState) => {
      const runtime = createTestTeamHubRuntime();

      servePeerActive(runtime, true);
      runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () =>
        directoryState === "pending"
          ? new Promise(() => {})
          : teamHubErrorResponse(
              500,
              "AGENT_DIRECTORY_UNAVAILABLE",
              "Directory unavailable.",
            ),
      );
      renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );
      const composer = await screen.findByLabelText("Message Room");
      fireEvent.change(composer, {
        target: { value: "typing without directory" },
      });
      expect(composer).toHaveValue("typing without directory");
      if (directoryState === "failed") {
        expect(
          await screen.findByText("Your agents are unavailable"),
        ).toBeVisible();
        expect(composer).toHaveValue("typing without directory");
      }
    },
  );

  it.each([false, undefined])(
    "does not unlock an unconfirmed peer while directory is pending (active=%s)",
    async (active) => {
      const runtime = createTestTeamHubRuntime();

      servePeerActive(runtime, active);
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agents",
        () => new Promise(() => {}),
      );
      renderRoomChat(
        runtime,
        testQueryClient(),
        "/t/tenant-northstar/rooms/room-dm-codex/chat",
      );
      await screen.findByText(
        active === false
          ? "This Agent has been deleted. Message and Run history remain available."
          : "Agent status is unavailable. Messages remain read-only.",
      );
      expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    },
  );

  it("keeps a peer missing from the completed directory read-only", async () => {
    const runtime = createTestTeamHubRuntime();

    servePeerActive(runtime, true);
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      items: [],
      page: { has_more: false },
    }));
    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );
    await screen.findByText(
      "Agent status is unavailable. Messages remain read-only.",
    );
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
  });

  it("keeps a legacy Agent DM without authoritative peer state read-only until directory retry", async () => {
    const runtime = createTestTeamHubRuntime();

    servePeerActive(runtime, undefined);
    const agents = await readTenantAgents(runtime);
    const listTenantAgents = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          500,
          "AGENT_DIRECTORY_UNAVAILABLE",
          "Directory unavailable.",
        ),
      )
      .mockReturnValue(agents);
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", listTenantAgents);

    renderRoomChat(
      runtime,
      testQueryClient(),
      "/t/tenant-northstar/rooms/room-dm-codex/chat",
    );

    expect(
      await screen.findByText(
        "Agent status is unavailable. Messages remain read-only.",
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText("Message Room")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listTenantAgents).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Message Room")).toBeVisible();
  });

  it("preserves the visible history position when an older page is prepended", async () => {
    const fixture = createTestTeamHubRuntime();

    const allMessages = await listRoomMessages(fixture, "room-all");
    let resolveOlder!: (page: TeamHubMessagePage) => void;
    const olderPage = new Promise<TeamHubMessagePage>((resolve) => {
      resolveOlder = resolve;
    });
    const listMessages = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce({
        items: allMessages.items.slice(2),
        page: { has_more: true, next_cursor: "older" },
        snapshot_room_seq: allMessages.snapshot_room_seq,
      })
      .mockReturnValueOnce(olderPage);
    fixture.server.on("GET", "/v0/rooms/{roomId}/messages", listMessages);
    const runtime = withoutRealtime(fixture);

    renderRoomChat(runtime, testQueryClient());

    await screen.findByText(/Keep the first release focused/);
    const timeline = screen.getByLabelText("Room timeline");
    let scrollHeight = 400;
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    // Scrolling near the top loads the older page; there is no button.
    timeline.scrollTop = 100;
    fireEvent.scroll(timeline);
    expect(
      screen.queryByRole("button", { name: /Load earlier/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("status", { name: "Loading earlier Messages" }),
    ).toBeVisible();
    scrollHeight = 620;
    resolveOlder({
      items: allMessages.items.slice(0, 2),
      page: { has_more: false },
      snapshot_room_seq: allMessages.snapshot_room_seq,
    });

    await screen.findByText(/I moved the launch notes/);
    await waitFor(() => expect(timeline.scrollTop).toBe(320));
  });

  it("positions initial history at the bottom before revealing the timeline", async () => {
    const fixture = createTestTeamHubRuntime();

    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "clientHeight",
    );
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1_000,
    });

    try {
      renderRoomChat(withoutRealtime(fixture), testQueryClient());

      const timeline = await screen.findByLabelText("Room timeline");
      expect(timeline).toHaveAttribute("data-initial-scroll-ready", "true");
      expect(timeline).not.toHaveClass("invisible");
      expect(timeline.scrollTop).toBe(1_000);
    } finally {
      restoreProperty(
        HTMLDivElement.prototype,
        "clientHeight",
        originalClientHeight,
      );
      restoreProperty(
        HTMLDivElement.prototype,
        "scrollHeight",
        originalScrollHeight,
      );
    }
  });

  it("keeps a realtime Message that arrives while an older page is loading", async () => {
    const fixture = createTestTeamHubRuntime();

    const allMessages = await listRoomMessages(fixture, "room-all");
    let resolveOlder!: (page: TeamHubMessagePage) => void;
    const olderPage = new Promise<TeamHubMessagePage>((resolve) => {
      resolveOlder = resolve;
    });
    const listMessages = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce({
        items: allMessages.items.slice(2),
        page: { has_more: true, next_cursor: "older" },
        snapshot_room_seq: allMessages.snapshot_room_seq,
      })
      .mockReturnValueOnce(olderPage);
    fixture.server.on("GET", "/v0/rooms/{roomId}/messages", listMessages);
    const queryClient = testQueryClient();

    renderRoomChat(withoutRealtime(fixture), queryClient);

    await screen.findByText(/Keep the first release focused/);
    const timeline = screen.getByLabelText("Room timeline");
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      value: 400,
    });
    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);
    await waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    appendCommittedMessage(queryClient, {
      ...message("message-realtime", "Arrived during pagination"),
      // Newer than fixture room-all messages so reconcile keeps it across page merge.
      created_at: "2026-08-12T12:00:00Z",
    });
    await waitFor(() =>
      expect(screen.getByText("Arrived during pagination")).toBeVisible(),
    );

    resolveOlder({
      items: allMessages.items.slice(0, 2),
      page: { has_more: false },
      snapshot_room_seq: allMessages.snapshot_room_seq,
    });

    await screen.findByText(/I moved the launch notes/);
    expect(screen.getByText("Arrived during pagination")).toBeVisible();
    expect(screen.getAllByText("Arrived during pagination")).toHaveLength(1);
  });

  it("follows new Messages only while the reader remains near the bottom", async () => {
    const fixture = createTestTeamHubRuntime();

    const runtime = withoutRealtime(fixture);
    const queryClient = testQueryClient();

    renderRoomChat(runtime, queryClient);

    const timeline = await screen.findByLabelText("Room timeline");
    let scrollHeight = 500;
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    timeline.scrollTop = 100;
    fireEvent.scroll(timeline);

    scrollHeight = 550;
    appendCommittedMessage(queryClient, message("message-new-1", "First"));
    await screen.findByText("First");
    expect(timeline.scrollTop).toBe(100);

    timeline.scrollTop = 345;
    fireEvent.scroll(timeline);
    scrollHeight = 600;
    appendCommittedMessage(queryClient, message("message-new-2", "Second"));
    await screen.findByText("Second");
    await waitFor(() => expect(timeline.scrollTop).toBe(600));
  });
});

describe("Room Chat replied Run", () => {
  beforeEach(async () => {
    await browserRoomMessageOutbox.clearAccount("account-jenny");
  });

  it("leaves the Dock when TeamHub marks the Run replied and returns when it is not", async () => {
    const scenario = repliedRunScenario();
    const queryClient = await loadedRoomChatQueryClient(scenario.runtime);
    await act(async () => {
      renderRoomChat(scenario.runtime, queryClient);
    });
    expect(
      await screen.findByRole("button", {
        name: "Open Agents working activity",
      }),
    ).toBeVisible();

    scenario.publish({ replied: true, revision: 2 });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Open Agents working activity",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Stop Codex's task" }),
    ).not.toBeInTheDocument();

    scenario.publish({ replied: false, revision: 3 });
    expect(
      await screen.findByRole("button", {
        name: "Open Agents working activity",
      }),
    ).toBeVisible();
  });

  it.each([true, false])(
    "sends a follow-up at once while the Run is active (replied=%s)",
    async (replied) => {
      const scenario = repliedRunScenario();
      scenario.publish({ replied, revision: 2 });
      const queryClient = await loadedRoomChatQueryClient(scenario.runtime);
      await act(async () => {
        renderRoomChat(scenario.runtime, queryClient);
      });

      const editor = await screen.findByLabelText("Message Room");
      fireEvent.change(editor, { target: { value: "@Cod" } });
      fireEvent.click(await screen.findByRole("option", { name: /^Codex/ }));
      fireEvent.change(editor, {
        target: {
          value: `${(editor as HTMLTextAreaElement).value}one more thing`,
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(scenario.createMessage).toHaveBeenCalledOnce(),
      );
      expect(scenario.createMessage.mock.calls[0]?.[0]).toMatchObject({
        body: expect.stringContaining("one more thing"),
        mentions: [expect.objectContaining({ id: "actor-codex" })],
      });
      expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    },
  );
});

function repliedRunScenario() {
  const fixture = withoutRealtime(createTestTeamHubRuntime());
  let onCollection: ((runStatuses: TeamHubRunStatus[]) => void) | undefined;
  let current: TeamHubRunStatus = {
    agent: { display_name: "Codex", id: "actor-codex", kind: "agent" },
    created_at: "2026-10-20T02:00:00Z",
    id: "run-status-replied",
    replied: false,
    revision: 1,
    room_id: "room-all",
    run_id: "run-replied",
    status: "active",
    updated_at: "2026-10-20T02:00:00Z",
  };
  const createMessage = vi.spyOn(
    roomMessageSender(fixture.client),
    "createMessage",
  );
  const runtime: TeamHubRuntime = {
    ...fixture,
    runStatuses: {
      subscribe(input) {
        onCollection = input.onCollection;
        input.onCollection([current]);
        return () => {
          onCollection = undefined;
        };
      },
    },
  };
  return {
    createMessage,
    publish(change: Partial<TeamHubRunStatus>) {
      current = { ...current, ...change };
      act(() => onCollection?.([current]));
    },
    runtime,
  };
}

function renderRoomChat(
  runtime: TeamHubRuntime,
  queryClient: QueryClient,
  initialEntry = "/t/tenant-northstar/rooms/room-all/chat",
  focusComposer = false,
) {
  const router = createMemoryRouter(
    [
      {
        element: <RoomChat />,
        path: "/t/:tenantId/rooms/:roomId/chat",
      },
      {
        element: <p>Unified Document</p>,
        path: "/t/:tenantId/documents/:documentId",
      },
    ],
    {
      initialEntries: [
        focusComposer
          ? { pathname: initialEntry, state: { focusComposer: true } }
          : initialEntry,
      ],
    },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <Suspense fallback={<p>Loading Room</p>}>
          <RouterProvider router={router} />
        </Suspense>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return router;
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function withoutRealtime(runtime: TeamHubRuntime): TeamHubRuntime {
  return {
    ...runtime,
    events: {
      ...runtime.events,
      subscribeRoom(input) {
        input.onStatusChange?.("connected");
        return () => undefined;
      },
    },
  };
}

function appendCommittedMessage(
  queryClient: QueryClient,
  nextMessage: TeamHubMessage,
) {
  act(() => {
    queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
      roomMessagesQueryKey("tenant-northstar", "room-all"),
      (current) => {
        if (!current?.pages[0]) {
          return current;
        }

        return {
          ...current,
          pages: [
            {
              ...current.pages[0],
              items: [...current.pages[0].items, nextMessage],
            },
            ...current.pages.slice(1),
          ],
        };
      },
    );
  });
}

function message(id: string, body: string): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "actor-codex",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    created_at: "2026-07-23T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-all",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-northstar",
  };
}

function presentedAttachment(available: boolean) {
  return {
    document: {
      current_version: { id: "version-1" },
      id: "document-1",
      title: "report.txt",
    },
    available,
    filename: "report.txt",
    id: "attachment-1",
    mediaType: "text/plain",
    sizeBytes: 12,
  };
}

// These two tests start after required Room data, while Actor and Run Status reads
// still start through their real mounted query and transport paths.
async function loadedRoomChatQueryClient(runtime: TeamHubRuntime) {
  const queryClient = testQueryClient();
  const tenantId = "tenant-northstar";
  const roomId = "room-all";
  await Promise.all([
    queryClient.ensureInfiniteQueryData(
      roomMessagesInfiniteQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureQueryData(
      roomQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureQueryData(
      roomMembersQueryOptions(runtime.client, tenantId, roomId),
    ),
    queryClient.ensureQueryData(teamHubIdentityQueryOptions(runtime.client)),
  ]);
  return queryClient;
}

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function createTestTeamHubRuntime() {
  const runtime = createDocumentTestRuntime();
  acceptRoomMessages(runtime);
  return runtime;
}

function readShareableDocuments(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/library/documents", {
      params: { query: { limit: 50, view: "shareable" } },
    }),
  );
}

function queriesTo(runtime: TestTeamHubRuntime, path: TeamHubApiPath) {
  return runtime.server
    .requestsTo("GET", path)
    .map((request) => Object.fromEntries(new URL(request.url).searchParams));
}

/** Serves every Room from the seed with the given Direct Room peer state. */
function servePeerActive(
  runtime: TestTeamHubRuntime,
  active: boolean | undefined,
) {
  runtime.server.on("GET", "/v0/rooms/{roomId}", ({ params }) => ({
    ...runtime.seed.rooms.find((room) => room.id === params.roomId),
    direct_peer_active: active,
  }));
}

function readTenantAgents(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agents", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

function readAgentAvailability(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agent-availability", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

function listRoomMessages(runtime: TestTeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
      params: { path: { roomId } },
    }),
  );
}
