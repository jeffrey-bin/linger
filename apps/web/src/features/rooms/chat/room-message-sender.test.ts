import { describe, expect, it, vi, type Mock } from "vitest";

import {
  createHttpTeamHubClient,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { roomMessageSender } from "./room-message-sender";

describe("roomMessageSender", () => {
  it("stages files in order and atomically submits their upload IDs", async () => {
    const progress = vi.fn();
    const uploadMessageAttachment = vi
      .fn()
      .mockImplementation(async (_roomId, file: File, _key, options) => {
        options?.onProgress?.(0.5);
        return { id: `upload-${file.name}` };
      });
    const createMessage = vi.fn<TestRouteHandler>(() => ({
      attachments: [
        {
          available: true,
          document_id: "document-1",
          document_version_id: "version-1",
          filename: "a.txt",
          id: "attachment-1",
          media_type: "text/plain",
          sha256: "a".repeat(64),
          size_bytes: 1,
        },
      ],
      author: {
        display_name: "Alice",
        id: "actor-1",
        kind: "human",
        tenant_id: "tenant-1",
      },
      created_at: "2026-08-03T10:00:00Z",
      id: "message-1",
      raw_message: "Review\na.txt",
      room_id: "room-1",
      segments: [],
      tenant_id: "tenant-1",
    }));
    const { client, server } = senderClient(uploadMessageAttachment);
    server.on("POST", "/v0/rooms/{roomId}/messages", createMessage);
    const adapter = roomMessageSender(client);

    const attachments = [
      { clientId: "client-a", file: new File(["a"], "a.txt") },
      { clientId: "client-b", file: new File(["b"], "b.txt") },
    ];
    await adapter.stageAttachment?.({
      attachment: attachments[0]!,
      idempotencyKey: "message-command-12345678",
      onProgress: (value) => progress("client-a", value),
      roomId: "room-1",
    });
    await adapter.stageAttachment?.({
      attachment: attachments[1]!,
      idempotencyKey: "message-command-12345678",
      onProgress: (value) => progress("client-b", value),
      roomId: "room-1",
    });
    expect(createMessage).not.toHaveBeenCalled();

    const result = await adapter.createMessage({
      attachments,
      body: "Review",
      idempotencyKey: "message-command-12345678",
      mentions: [],
      onAttachmentProgress: progress,
      roomId: "room-1",
    });

    expect(
      uploadMessageAttachment.mock.calls.map((call) => call[1].name),
    ).toEqual(["a.txt", "b.txt"]);
    expect(uploadMessageAttachment.mock.calls[0]?.[2]).toBe(
      "message-command-12345678:attachment:client-a",
    );
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          attachment_upload_ids: ["upload-a.txt", "upload-b.txt"],
          raw_message: "Review",
        }),
        params: { roomId: "room-1" },
      }),
    );
    expect(idempotencyKeys(server)).toEqual(["message-command-12345678"]);
    expect(progress).toHaveBeenCalledWith("client-a", 0.5);
    expect(result.presentation.attachments[0]).toMatchObject({
      available: true,
      filename: "a.txt",
    });
  });

  it("omits attachment_upload_ids for text-only live Messages", async () => {
    const createMessage = vi.fn<TestRouteHandler>(() => committedLiveMessage());
    const { client, server } = senderClient(vi.fn());
    server.on("POST", "/v0/rooms/{roomId}/messages", createMessage);
    const adapter = roomMessageSender(client);

    await adapter.createMessage({
      attachments: [],
      body: "Text only",
      idempotencyKey: "message-text-only-12345678",
      mentions: [],
      roomId: "room-1",
    });

    expect(createMessage.mock.calls[0]?.[0].body).toEqual({
      raw_message: "Text only",
      segments: [{ content: "Text only", type: "text" }],
    });
  });

  it("retries only the failed upload intent while reusing a successful upload", async () => {
    const uploadMessageAttachment = vi
      .fn()
      .mockResolvedValueOnce({ id: "upload-a" })
      .mockRejectedValueOnce(new Error("second upload failed"))
      .mockResolvedValueOnce({ id: "upload-b-retry" });
    const createMessage = vi.fn<TestRouteHandler>(() => committedLiveMessage());
    const { client, server } = senderClient(uploadMessageAttachment);
    server.on("POST", "/v0/rooms/{roomId}/messages", createMessage);
    const adapter = roomMessageSender(client);
    const input = {
      attachments: [
        { clientId: "client-a", file: new File(["a"], "a.txt") },
        { clientId: "client-b", file: new File(["b"], "b.txt") },
      ],
      body: "Retry me",
      idempotencyKey: "message-retry-12345678",
      mentions: [],
      roomId: "room-1",
    };

    await expect(adapter.createMessage(input)).rejects.toThrow(
      "second upload failed",
    );
    await adapter.createMessage(input);

    expect(uploadMessageAttachment).toHaveBeenCalledTimes(3);
    expect(uploadMessageAttachment.mock.calls.map((call) => call[2])).toEqual([
      "message-retry-12345678:attachment:client-a",
      "message-retry-12345678:attachment:client-b",
      "message-retry-12345678:attachment:client-b:retry:1",
    ]);
    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          attachment_upload_ids: ["upload-a", "upload-b-retry"],
        }),
        params: { roomId: "room-1" },
      }),
    );
    expect(idempotencyKeys(server)).toEqual(["message-retry-12345678"]);
  });

  it("rebinds cancellation to a retry attempt and cancels its available uploads", async () => {
    const firstController = new AbortController();
    const retryController = new AbortController();
    let rejectRetryUpload!: (error: unknown) => void;
    const uploadMessageAttachment = vi
      .fn()
      .mockResolvedValueOnce({ id: "upload-a" })
      .mockRejectedValueOnce(new Error("second upload failed"))
      .mockImplementationOnce(
        async (_roomId, _file, _key, options) =>
          new Promise((_resolve, reject) => {
            rejectRetryUpload = reject;
            options?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
    const cancelMessageAttachmentUpload = vi.fn<TestRouteHandler>(
      () => undefined,
    );
    const { client, server } = senderClient(uploadMessageAttachment);
    server.on(
      "DELETE",
      "/v0/rooms/{roomId}/message-attachment-uploads/{attachmentUploadId}",
      cancelMessageAttachmentUpload,
    );
    const adapter = roomMessageSender(client);
    const input = {
      attachments: [
        { clientId: "client-a", file: new File(["a"], "a.txt") },
        { clientId: "client-b", file: new File(["b"], "b.txt") },
      ],
      body: "Retry cancellation",
      idempotencyKey: "message-retry-cancel-12345678",
      mentions: [],
      roomId: "room-1",
    };

    await expect(
      adapter.createMessage({ ...input, signal: firstController.signal }),
    ).rejects.toThrow("second upload failed");
    const retry = adapter.createMessage({
      ...input,
      signal: retryController.signal,
    });
    await vi.waitFor(() => expect(rejectRetryUpload).toBeTypeOf("function"));

    retryController.abort();
    await expect(retry).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelMessageAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(cancelMessageAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { attachmentUploadId: "upload-a", roomId: "room-1" },
      }),
    );
  });

  it("replays an uncertain createMessage with the same upload IDs and idempotency key", async () => {
    const uploadMessageAttachment = vi
      .fn()
      .mockResolvedValueOnce({ id: "upload-a" })
      .mockResolvedValueOnce({ id: "upload-b" });
    const createMessage = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new Error("connection lost");
      })
      .mockImplementationOnce(() => committedLiveMessage());
    const { client, server } = senderClient(uploadMessageAttachment);
    server.on("POST", "/v0/rooms/{roomId}/messages", createMessage);
    const adapter = roomMessageSender(client);
    const input = {
      attachments: [
        { clientId: "client-a", file: new File(["a"], "a.txt") },
        { clientId: "client-b", file: new File(["b"], "b.txt") },
      ],
      body: "Replay me",
      idempotencyKey: "message-unknown-12345678",
      mentions: [],
      roomId: "room-1",
    };

    await expect(adapter.createMessage(input)).rejects.toBeInstanceOf(
      TeamHubTransportError,
    );
    await adapter.createMessage(input);

    expect(uploadMessageAttachment).toHaveBeenCalledTimes(2);
    expect(idempotencyKeys(server)).toEqual([
      "message-unknown-12345678",
      "message-unknown-12345678",
    ]);
    expect(createMessage.mock.calls[0]?.[0].body).toEqual(
      createMessage.mock.calls[1]?.[0].body,
    );
  });

  it("cancels available uploads when an in-flight composition is aborted", async () => {
    const controller = new AbortController();
    let rejectUpload!: (error: unknown) => void;
    const uploadMessageAttachment = vi
      .fn()
      .mockResolvedValueOnce({ id: "upload-a" })
      .mockImplementationOnce(
        async (_roomId, _file, _key, options) =>
          new Promise((_resolve, reject) => {
            rejectUpload = reject;
            options?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
    const cancelMessageAttachmentUpload = vi.fn<TestRouteHandler>(
      () => undefined,
    );
    const { client, server } = senderClient(uploadMessageAttachment);
    server.on(
      "DELETE",
      "/v0/rooms/{roomId}/message-attachment-uploads/{attachmentUploadId}",
      cancelMessageAttachmentUpload,
    );
    const adapter = roomMessageSender(client);
    const pending = adapter.createMessage({
      attachments: [
        { clientId: "client-a", file: new File(["a"], "a.txt") },
        { clientId: "client-b", file: new File(["b"], "b.txt") },
      ],
      body: "",
      idempotencyKey: "message-cancel-12345678",
      mentions: [],
      roomId: "room-1",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(rejectUpload).toBeTypeOf("function"));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelMessageAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { attachmentUploadId: "upload-a", roomId: "room-1" },
      }),
    );
  });
});

function senderClient(uploadMessageAttachment: Mock) {
  const server = new TeamHubTestServer();
  const { api } = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client: { api, uploadMessageAttachment }, server };
}

function idempotencyKeys(server: TeamHubTestServer) {
  return server
    .requestsTo("POST", "/v0/rooms/{roomId}/messages")
    .map((request) => request.headers.get("Idempotency-Key"));
}

function committedLiveMessage() {
  return {
    attachments: [],
    author: {
      display_name: "Alice",
      id: "actor-1",
      kind: "human" as const,
      tenant_id: "tenant-1",
    },
    created_at: "2026-08-03T10:00:00Z",
    id: "message-1",
    raw_message: "Message",
    room_id: "room-1",
    segments: [{ content: "Message", type: "text" as const }],
    tenant_id: "tenant-1",
  };
}
