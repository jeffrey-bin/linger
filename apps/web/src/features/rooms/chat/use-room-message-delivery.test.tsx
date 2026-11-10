import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  createHttpTeamHubClient,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import type {
  TeamHubActorRef,
  TeamHubMessageCreateInput,
  TeamHubMessagePage,
} from "@/features/teamhub/teamhub-types";

import {
  roomMessageSender,
  type RoomMessageSender,
} from "./room-message-sender";
import {
  createMemoryRoomMessageOutbox,
  type PersistedRoomMessageIntent,
} from "./room-message-outbox";
import { useRoomMessageDelivery } from "./use-room-message-delivery";

describe("Room Message delivery identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps confirmed history fresh after appending the authoritative response", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["messages"], {
      pages: [{ items: [], has_more: false }],
      pageParams: [null],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { client } = messageClient(() => committedMessage());
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(client),
          messagesQueryKey: ["messages"],
          roomId: "room-1",
          ...useTestOutbox("room-1"),
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.sendMessage({
        body: "Review this",
        files: [],
        mentions: [],
      });
    });
    expect(
      queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(["messages"])
        ?.pages[0]?.items,
    ).toEqual([committedMessage()]);
    expect(queryClient.getQueryState(["messages"])?.isInvalidated).toBe(false);
  });

  it("accepts durable queued messages before HTTP and sends them in order", async () => {
    let finishFirst!: (message: ReturnType<typeof committedMessage>) => void;
    const createMessage = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockImplementationOnce(() => ({
        ...committedMessage(),
        id: "message-2",
      }));
    const { result } = renderLiveDelivery({ createMessage });
    await act(async () => {
      expect(
        await result.current.enqueueMessage({
          body: "First",
          files: [],
          mentions: [],
        }),
      ).toEqual({ ok: true });
      expect(
        await result.current.enqueueMessage({
          body: "Second",
          files: [],
          mentions: [],
        }),
      ).toEqual({ ok: true });
    });
    expect(result.current.outgoing.map((item) => item.body)).toEqual([
      "First",
      "Second",
    ]);
    expect(createMessage).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst(committedMessage()));
    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    expect(
      messageBodies(createMessage).map((body) => body.raw_message),
    ).toEqual(["First", "Second"]);
    await waitFor(() => expect(result.current.outgoing).toHaveLength(0));
  });

  it("keeps an accepted message retryable after a later network failure", async () => {
    let fail!: (error: Error) => void;
    const createMessage = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      )
      .mockImplementationOnce(() => committedMessage());
    const { result, server } = renderLiveDelivery({ createMessage });
    await act(async () => {
      expect(
        await result.current.enqueueMessage({
          body: "Retain me",
          files: [],
          mentions: [],
        }),
      ).toEqual({ ok: true });
    });
    const key = result.current.outgoing[0]!.idempotencyKey;
    await act(async () => fail(new TypeError("Failed to fetch")));
    await waitFor(() =>
      expect(result.current.outgoing[0]?.status).toBe("unknown"),
    );
    act(() =>
      result.current.retryMessage(result.current.outgoing[0]!.clientId),
    );
    await waitFor(() => expect(result.current.outgoing).toHaveLength(0));
    expect(idempotencyKeys(server)[1]).toBe(key);
  });

  it("reuses a Voice Mode turn's command and pending-row identity on retry", async () => {
    const createMessage = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new TypeError("Failed to fetch");
      })
      .mockImplementation(() => committedMessage());
    const { result, server } = renderLiveDelivery({ createMessage });
    const turn = {
      body: "same round",
      files: [],
      mentions: [],
      messageIdempotencyKey: "voice-mode:turn-1",
      voiceLiveTurn: { voice_session_id: "voice-1", turn_id: "lt-1" },
    };
    await act(async () => {
      await result.current.sendMessage(turn);
    });
    expect(result.current.outgoing).toHaveLength(1);
    expect(result.current.outgoing[0]?.clientId).toBe("voice-mode:turn-1");
    await act(async () => {
      await result.current.sendMessage(turn);
    });
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(idempotencyKeys(server)).toEqual([
      "voice-mode:turn-1",
      "voice-mode:turn-1",
    ]);
    expect(messageBodies(createMessage)[0]?.voice_live_turn).toEqual(
      turn.voiceLiveTurn,
    );
    expect(messageBodies(createMessage)[1]?.voice_live_turn).toEqual(
      turn.voiceLiveTurn,
    );
    expect(result.current.outgoing).toHaveLength(0);
  });

  it("delegates Mention admission atomically to Message creation", async () => {
    const createMessage = vi.fn<TestRouteHandler>(() => committedMessage());
    const { result, server } = renderLiveDelivery({ createMessage });

    act(() => {
      void result.current.sendMessage({
        body: "Hello",
        files: [],
        mentions: [],
      });
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(
      server.requestsTo("PUT", "/v0/rooms/{roomId}/members/{actorId}"),
    ).toHaveLength(0);
  });

  it("removes the pending row before durable Outbox cleanup completes", async () => {
    const createMessage = vi.fn<TestRouteHandler>(() => committedMessage());
    const queryClient = new QueryClient();
    const messagesQueryKey = ["messages"];
    queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
      messagesQueryKey,
      {
        pageParams: [undefined],
        pages: [
          {
            items: [],
            page: { has_more: false },
            snapshot_room_seq: 1,
          },
        ],
      },
    );
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const stored = createMemoryRoomMessageOutbox();
    const outbox = {
      clearAccount: (accountId: string) => stored.clearAccount(accountId),
      list: (scope: Parameters<typeof stored.list>[0]) => stored.list(scope),
      put: (intent: Parameters<typeof stored.put>[0]) => stored.put(intent),
      remove: vi.fn(() => cleanup),
    } satisfies typeof stored;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { client } = messageClient(createMessage);
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(client),
          messagesQueryKey,
          outbox,
          roomId: "room-1",
          outboxScope: testOutboxScope("room-1"),
        }),
      { wrapper },
    );

    act(() => {
      void result.current.sendMessage({
        body: "No duplicate row",
        files: [],
        mentions: [],
      });
    });

    await waitFor(() => expect(outbox.remove).toHaveBeenCalledOnce());
    expect(result.current.outgoing).toEqual([]);
    expect(
      queryClient
        .getQueryData<InfiniteData<TeamHubMessagePage>>(messagesQueryKey)
        ?.pages[0]?.items.map((message) => message.id),
    ).toEqual(["message-1"]);

    await act(async () => releaseCleanup());
  });

  it("sends selected context IDs with the ordinary top-level Message", async () => {
    const createMessage = vi.fn<TestRouteHandler>(() => committedMessage());
    const { result } = renderLiveDelivery({ createMessage });
    const contextMessage = committedMessage();
    contextMessage.id = "message-context";

    act(() => {
      void result.current.sendMessage({
        body: "Use this context",
        contextMessages: [contextMessage],
        files: [],
        mentions: [],
      });
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(messageBodies(createMessage)[0]).toMatchObject({
      context_message_ids: ["message-context"],
      raw_message: "Use this context",
    });
  });

  it("sends the exact Document Version as context through live composition", async () => {
    const createMessage = vi.fn<TestRouteHandler>(() => committedMessage());
    const { result } = renderLiveDelivery({ createMessage });

    act(() => {
      void result.current.sendMessage({
        documentContexts: [
          {
            documentId: "document-report",
            documentVersionId: "version-report-v1",
            filename: "report.md",
            sourceRoomId: "room-source",
            sourceRoomName: "Source Room",
            versionNumber: 1,
          },
        ],
        body: "",
        files: [],
        mentions: [],
      });
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(messageBodies(createMessage)[0]).toMatchObject({
      context_document_version_ids: ["version-report-v1"],
      raw_message: "",
    });
  });

  it("persists the exact Document Version through a composition adapter", async () => {
    const createMessage = vi
      .fn<RoomMessageSender["createMessage"]>()
      .mockResolvedValue({
        message: committedMessage(),
        presentation: { attachments: [], mentions: [] },
      });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          roomId: "room-target",
          ...useTestOutbox("room-target"),
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.sendMessage({
        documentContexts: [
          {
            documentId: "document-report",
            documentVersionId: "version-report-v1",
            filename: "report.md",
            sourceRoomId: "room-source",
            sourceRoomName: "Source Room",
            versionNumber: 1,
          },
        ],
        body: "Review it",
        files: [],
        mentions: [],
      });
    });

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contextDocumentVersionIds: ["version-report-v1"],
      }),
    );
  });
  it("keeps fallback local IDs unique when UUID, time, and randomness repeat", async () => {
    const createMessage = vi.fn<RoomMessageSender["createMessage"]>(
      () => new Promise<never>(() => undefined),
    );
    vi.stubGlobal("crypto", {});
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          roomId: "room-1",
          ...useTestOutbox("room-1"),
        }),
      { wrapper },
    );

    act(() => {
      void result.current.sendMessage({
        body: "",
        files: [new File(["a"], "a.txt"), new File(["b"], "b.txt")],
        mentions: [],
      });
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    const attachmentIds = createMessage.mock.calls[0]![0].attachments.map(
      (attachment) => attachment.clientId,
    );
    expect(new Set(attachmentIds).size).toBe(2);
    expect(result.current.outgoing[0]?.clientId).not.toBe(attachmentIds[0]);
    expect(result.current.outgoing[0]?.clientId).not.toBe(attachmentIds[1]);
  });

  it("does not submit parallel retries for the same pending Message", async () => {
    const createMessage = vi
      .fn<RoomMessageSender["createMessage"]>()
      .mockRejectedValueOnce(new Error("First delivery failed."))
      .mockImplementation(() => new Promise<never>(() => undefined));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          roomId: "room-1",
          ...useTestOutbox("room-1"),
        }),
      { wrapper },
    );

    act(() => {
      void result.current.sendMessage({
        body: "Retry me",
        files: [],
        mentions: [],
      });
    });

    await waitFor(() =>
      expect(result.current.outgoing[0]?.status).toBe("unknown"),
    );
    const clientId = result.current.outgoing[0]!.clientId;
    act(() => {
      result.current.retryMessage(clientId);
      result.current.retryMessage(clientId);
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
  });

  it("restores a failed Message after remount and retries the original idempotent intent", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const createMessage = vi
      .fn<RoomMessageSender["createMessage"]>()
      .mockRejectedValueOnce(new Error("Connection lost."))
      .mockResolvedValue({
        message: committedMessage(),
        presentation: { attachments: [], mentions: [] },
      });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const renderDelivery = () =>
      renderHook(
        () =>
          useRoomMessageDelivery({
            composition: sender(createMessage),
            messagesQueryKey: ["messages"],
            outbox,
            outboxScope: {
              accountId: "account-1",
              roomId: "room-1",
              tenantId: "tenant-1",
            },
            roomId: "room-1",
          }),
        { wrapper },
      );
    const first = renderDelivery();

    act(() => {
      void first.result.current.sendMessage({
        body: "Persist this retry",
        files: [],
        mentions: [],
      });
    });
    await waitFor(() =>
      expect(first.result.current.outgoing[0]?.status).toBe("unknown"),
    );
    const originalKey = createMessage.mock.calls[0]?.[0].idempotencyKey;
    first.unmount();

    const restored = renderDelivery();
    await waitFor(() =>
      expect(restored.result.current.outgoing[0]).toMatchObject({
        body: "Persist this retry",
        status: "unknown",
      }),
    );
    act(() => {
      restored.result.current.retryMessage(
        restored.result.current.outgoing[0]!.clientId,
      );
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    expect(createMessage.mock.calls[1]?.[0].idempotencyKey).toBe(originalKey);
    await waitFor(() => expect(restored.result.current.outgoing).toEqual([]));
  });

  it("keeps a durable unknown Message when navigation aborts its send", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    const createMessage = vi.fn<RoomMessageSender["createMessage"]>(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const first = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );

    act(() => {
      void first.result.current.sendMessage({
        body: "Survive navigation",
        files: [],
        mentions: [],
      });
    });
    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    first.unmount();

    await expect(outbox.list(scope)).resolves.toHaveLength(1);
    const restored = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(restored.result.current.outgoing[0]).toMatchObject({
        body: "Survive navigation",
        status: "unknown",
      }),
    );
    restored.unmount();
  });

  it("keeps the original idempotent intent when cancel races an in-flight request", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    const createMessage = vi.fn<RoomMessageSender["createMessage"]>(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const delivery = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );

    act(() => {
      void delivery.result.current.sendMessage({
        body: "Do not lose this intent",
        files: [],
        mentions: [],
      });
    });
    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    const originalKey = createMessage.mock.calls[0]?.[0].idempotencyKey;
    await act(() =>
      delivery.result.current.cancelMessage(
        delivery.result.current.outgoing[0]!.clientId,
      ),
    );

    expect(delivery.result.current.outgoing[0]).toMatchObject({
      error: expect.stringContaining("may already have reached TeamHub"),
      status: "unknown",
    });
    await expect(outbox.list(scope)).resolves.toMatchObject([
      { idempotencyKey: originalKey, status: "unknown" },
    ]);
    delivery.unmount();

    const restored = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(restored.result.current.outgoing[0]).toMatchObject({
        idempotencyKey: originalKey,
        status: "unknown",
      }),
    );
    restored.unmount();
  });

  it("discards a canceled intent when HTTP delivery has not started", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const outbox = {
      ...stored,
      put: vi.fn(async (intent: PersistedRoomMessageIntent) => {
        await persistence;
        await stored.put(intent);
      }),
    } satisfies typeof stored;
    const createMessage = vi.fn<RoomMessageSender["createMessage"]>();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );

    act(() => {
      void result.current.sendMessage({
        body: "Cancel before HTTP",
        files: [],
        mentions: [],
      });
    });
    await waitFor(() => expect(outbox.put).toHaveBeenCalledOnce());
    let cancel!: Promise<void>;
    act(() => {
      cancel = result.current.cancelMessage(
        result.current.outgoing[0]!.clientId,
      );
    });
    await act(async () => finishPersistence());
    await act(async () => cancel);

    expect(createMessage).not.toHaveBeenCalled();
    expect(result.current.outgoing).toEqual([]);
    await expect(outbox.list(scope)).resolves.toEqual([]);
  });

  it("shows all restored Messages when one normalization write fails", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    const first = persistedIntent(scope, "local-1", "First restored Message");
    const second = persistedIntent(scope, "local-2", "Second restored Message");
    await stored.put(first);
    await stored.put(second);
    const outbox = {
      ...stored,
      put: vi
        .fn<(intent: PersistedRoomMessageIntent) => Promise<void>>()
        .mockRejectedValueOnce(new Error("IndexedDB transaction aborted."))
        .mockImplementation((intent) => stored.put(intent)),
    } satisfies typeof stored;
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(messageClient().client),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.outgoing).toHaveLength(2));
    expect(result.current.outgoing).toMatchObject([
      { body: "First restored Message", status: "unknown" },
      { body: "Second restored Message", status: "unknown" },
    ]);
    await waitFor(() =>
      expect(result.current.outboxError).toContain(
        "interrupted delivery state could not be updated",
      ),
    );
  });

  it("does not send before local persistence succeeds and exposes quota failures", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const outbox = {
      clearAccount: (accountId: string) => stored.clearAccount(accountId),
      list: (scope: Parameters<typeof stored.list>[0]) => stored.list(scope),
      put: vi
        .fn()
        .mockRejectedValueOnce(
          new DOMException("Quota exceeded", "QuotaExceededError"),
        )
        .mockImplementation((intent) => stored.put(intent)),
      remove: (scope: Parameters<typeof stored.remove>[0], clientId: string) =>
        stored.remove(scope, clientId),
    } satisfies typeof stored;
    const createMessage = vi
      .fn<RoomMessageSender["createMessage"]>()
      .mockResolvedValue({
        message: committedMessage(),
        presentation: { attachments: [], mentions: [] },
      });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: {
            accountId: "account-1",
            roomId: "room-1",
            tenantId: "tenant-1",
          },
          roomId: "room-1",
        }),
      { wrapper },
    );

    await act(async () => {
      expect(
        await result.current.enqueueMessage({
          body: "Persist before send",
          files: [],
          mentions: [],
        }),
      ).toMatchObject({ ok: false });
    });
    expect(createMessage).not.toHaveBeenCalled();
    expect(result.current.outgoing[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("browser storage is full"),
    });

    act(() =>
      result.current.retryMessage(result.current.outgoing[0]!.clientId),
    );
    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.outgoing).toEqual([]));
  });

  it("does not resurrect a committed Outbox entry after attachment progress", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const outbox = {
      clearAccount: vi.fn((accountId: string) =>
        stored.clearAccount(accountId),
      ),
      list: vi.fn((scope) => stored.list(scope)),
      put: vi.fn((intent) => stored.put(intent)),
      remove: vi.fn((scope, clientId) => stored.remove(scope, clientId)),
    } satisfies typeof stored;
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    const createMessage = vi.fn<RoomMessageSender["createMessage"]>(
      async ({ onAttachmentProgress, attachments }) => {
        onAttachmentProgress?.(attachments[0]!.clientId, 0.5);
        onAttachmentProgress?.(attachments[0]!.clientId, 1);
        return {
          message: committedMessage(),
          presentation: { attachments: [], mentions: [] },
        };
      },
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: scope,
          roomId: "room-1",
        }),
      { wrapper },
    );

    await act(() =>
      result.current.sendMessage({
        body: "Send attachment",
        files: [new File(["report"], "report.txt")],
        mentions: [],
      }),
    );

    expect(outbox.put).toHaveBeenCalledOnce();
    expect(outbox.remove).toHaveBeenCalledOnce();
    await expect(outbox.list(scope)).resolves.toEqual([]);
  });

  it("keeps a sent Message visible as unknown until its Outbox row is removed", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const outbox = {
      clearAccount: (accountId: string) => stored.clearAccount(accountId),
      list: (scope: Parameters<typeof stored.list>[0]) => stored.list(scope),
      put: (intent: Parameters<typeof stored.put>[0]) => stored.put(intent),
      remove: vi
        .fn()
        .mockRejectedValueOnce(new Error("IndexedDB transaction aborted."))
        .mockImplementation((scope, clientId) =>
          stored.remove(scope, clientId),
        ),
    } satisfies typeof stored;
    const createMessage = vi
      .fn<RoomMessageSender["createMessage"]>()
      .mockResolvedValue({
        message: committedMessage(),
        presentation: { attachments: [], mentions: [] },
      });
    const onMessageCommitted = vi.fn();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const scope = {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    };
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: sender(createMessage),
          messagesQueryKey: ["messages"],
          onMessageCommitted,
          outbox,
          outboxScope: scope,
          roomId: scope.roomId,
        }),
      { wrapper },
    );

    await act(() =>
      result.current.sendMessage({
        body: "Committed but not cleared",
        files: [],
        mentions: [],
      }),
    );
    expect(result.current.outgoing[0]).toMatchObject({
      status: "unknown",
      error: expect.stringContaining("was sent"),
    });
    expect(onMessageCommitted).toHaveBeenCalledOnce();
    expect(onMessageCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-1" }),
    );
    await expect(outbox.list(scope)).resolves.toHaveLength(1);

    act(() =>
      result.current.retryMessage(result.current.outgoing[0]!.clientId),
    );
    await waitFor(() => expect(result.current.outgoing).toEqual([]));
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[1]?.[0].idempotencyKey).toBe(
      createMessage.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it("exposes Outbox restore failures instead of silently hiding saved Messages", async () => {
    const stored = createMemoryRoomMessageOutbox();
    const outbox = {
      ...stored,
      list: vi.fn().mockRejectedValue(new Error("IndexedDB is unavailable.")),
    } satisfies typeof stored;
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(messageClient().client),
          messagesQueryKey: ["messages"],
          outbox,
          outboxScope: {
            accountId: "account-1",
            roomId: "room-1",
            tenantId: "tenant-1",
          },
          roomId: "room-1",
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.outboxError).toContain(
        "Saved Messages could not be restored",
      ),
    );
  });

  it("sends structured references through the live composition", async () => {
    const agent: TeamHubActorRef = {
      display_name: "A1",
      id: "actor-a1",
      kind: "agent",
      tenant_id: "tenant-a",
    };
    const createMessage = vi.fn<TestRouteHandler>(() => ({
      author: {
        display_name: "Alice",
        id: "actor-alice",
        kind: "human",
        tenant_id: "tenant-a",
      },
      created_at: "2026-07-24T10:00:00Z",
      id: "message-1",
      raw_message: "@A1 please review",
      room_id: "room-1",
      segments: [
        {
          content: "@A1",
          target: "actor-a1",
          target_type: "agent",
          type: "reference",
        },
        { content: " please review", type: "text" },
      ],
      tenant_id: "tenant-a",
    }));
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { client } = messageClient(createMessage);
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(client),
          messagesQueryKey: ["messages"],
          roomId: "room-1",
          ...useTestOutbox("room-1"),
        }),
      { wrapper },
    );

    act(() => {
      void result.current.sendMessage({
        body: "@A1 please review",
        files: [],
        mentions: [agent],
      });
    });

    await waitFor(() => expect(createMessage).toHaveBeenCalledOnce());
    expect(messageBodies(createMessage)[0]).toEqual({
      raw_message: "@A1 please review",
      segments: [
        {
          content: "@A1",
          target: "actor-a1",
          target_type: "agent",
          type: "reference",
        },
        { content: " please review", type: "text" },
      ],
    });
  });

  it("reports structured mentions only after Message HTTP succeeds", async () => {
    const agent: TeamHubActorRef = {
      display_name: "A1",
      id: "actor-a1",
      kind: "agent",
      tenant_id: "tenant-a",
    };
    const onMessageCommitted = vi.fn();
    const createMessage = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new Error("offline");
      })
      .mockImplementationOnce(() => committedMessage());
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { client } = messageClient(createMessage);
    const { result } = renderHook(
      () =>
        useRoomMessageDelivery({
          composition: liveComposition(client),
          messagesQueryKey: ["messages"],
          onMessageCommitted,
          roomId: "room-1",
          ...useTestOutbox("room-1"),
        }),
      { wrapper },
    );

    await act(() =>
      result.current.sendMessage({
        body: "@A1 review",
        files: [],
        mentions: [agent],
      }),
    );
    expect(onMessageCommitted).not.toHaveBeenCalled();

    await act(() =>
      result.current.sendMessage({
        body: "@A1 review",
        files: [],
        mentions: [agent],
      }),
    );
    expect(onMessageCommitted).toHaveBeenCalledOnce();
    expect(onMessageCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-1", mentions: [agent] }),
    );
  });
});

function renderLiveDelivery({
  createMessage,
}: {
  createMessage: TestRouteHandler;
}) {
  const { client, server } = messageClient(createMessage);
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () =>
      useRoomMessageDelivery({
        composition: liveComposition(client),
        messagesQueryKey: ["messages"],
        roomId: "room-1",
        ...useTestOutbox("room-1"),
      }),
    { wrapper },
  );
  return { ...view, server };
}

/**
 * A client whose only route creates Messages, so tests observe the exact HTTP
 * request; any other TeamHub request fails the test.
 */
function messageClient(createMessage?: TestRouteHandler) {
  const server = new TeamHubTestServer();
  if (createMessage)
    server.on("POST", "/v0/rooms/{roomId}/messages", createMessage);
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client, server };
}

/** The live adapter over a test client. */
function liveComposition(client: TeamHubClient) {
  return roomMessageSender(client);
}

function messageBodies(createMessage: Mock<TestRouteHandler>) {
  return createMessage.mock.calls.map(
    ([request]) => request.body as TeamHubMessageCreateInput,
  );
}

function idempotencyKeys(server: TeamHubTestServer) {
  return server
    .requestsTo("POST", "/v0/rooms/{roomId}/messages")
    .map((request) => request.headers.get("Idempotency-Key"));
}

function sender(
  createMessage: RoomMessageSender["createMessage"],
): RoomMessageSender {
  return {
    cancelAttachment: async () => undefined,
    createMessage,
    stageAttachment: async () => undefined,
  };
}

function committedMessage() {
  return {
    attachments: [],
    author: {
      display_name: "Alice",
      id: "actor-alice",
      kind: "human" as const,
      tenant_id: "tenant-a",
    },
    created_at: "2026-07-24T10:00:00Z",
    id: "message-1",
    message_kind: "conversation" as const,
    raw_message: "Review this",
    room_id: "room-1",
    segments: [{ content: "Review this", type: "text" as const }],
    tenant_id: "tenant-a",
  };
}

function persistedIntent(
  scope: PersistedRoomMessageIntent["scope"],
  clientId: string,
  body: string,
): PersistedRoomMessageIntent {
  return {
    attachmentInputs: [],
    attachments: [],
    body,
    clientId,
    contextDocumentVersionIds: [],
    contextMessages: [],
    createdAt: Date.now(),
    documentReferences: [],
    idempotencyKey: `idempotency-${clientId}`,
    mentions: [],
    scope,
    skillReferences: [],
    status: "sending",
    wireBody: body,
  };
}

function testOutboxScope(roomId: string) {
  return { accountId: "account-1", roomId, tenantId: "tenant-1" };
}

/** A fresh Outbox per hook, so no test restores another test's Messages. */
function useTestOutbox(roomId: string) {
  const [outbox] = useState(createMemoryRoomMessageOutbox);
  return { outbox, outboxScope: testOutboxScope(roomId) };
}
