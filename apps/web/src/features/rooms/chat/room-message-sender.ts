import {
  idempotencyHeader,
  teamHubData,
  teamHubDone,
} from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { createTeamHubMessageContent } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubMessageDocumentReference,
  TeamHubMessageSkillReference,
} from "@/features/teamhub/teamhub-message-content";
import {
  presentTeamHubMessageAttachments,
  type TeamHubCompositionAttachmentInput,
  type TeamHubMessagePresentation,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubMessageAttachmentUpload,
  TeamHubVoiceLiveTurnMarker,
} from "@/features/teamhub/teamhub-types";

/**
 * Sends Room Messages with their attachments. It keeps each send's staged
 * uploads by idempotency key, so a retry replays the same upload IDs.
 */
export interface RoomMessageSender {
  cancelAttachment(input: {
    attachmentClientId: string;
    idempotencyKey: string;
    roomId: string;
  }): Promise<void>;
  createMessage(input: {
    attachments: TeamHubCompositionAttachmentInput[];
    body: string;
    contextDocumentVersionIds?: string[];
    documentReferences?: TeamHubMessageDocumentReference[];
    idempotencyKey: string;
    mentions: TeamHubActorRef[];
    skillReferences?: TeamHubMessageSkillReference[];
    contextMessageIds?: string[];
    voiceLiveTurn?: TeamHubVoiceLiveTurnMarker;
    onAttachmentProgress?: (clientId: string, progress: number) => void;
    roomId: string;
    signal?: AbortSignal;
  }): Promise<{
    message: TeamHubMessage;
    presentation: TeamHubMessagePresentation;
  }>;
  stageAttachment(input: {
    attachment: TeamHubCompositionAttachmentInput;
    idempotencyKey: string;
    onProgress?: (progress: number) => void;
    roomId: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

type RoomMessageClient = Pick<TeamHubClient, "api" | "uploadMessageAttachment">;

const senders = new WeakMap<RoomMessageClient, RoomMessageSender>();

/** Returns the one sender for a client, so pending sends survive remounts. */
export function roomMessageSender(
  client: RoomMessageClient,
): RoomMessageSender {
  let sender = senders.get(client);
  if (!sender) {
    sender = createRoomMessageSender(client);
    senders.set(client, sender);
  }
  return sender;
}

function createRoomMessageSender(client: RoomMessageClient): RoomMessageSender {
  interface UploadIntent {
    attempt: number;
    clientId: string;
    status: "available" | "cancelled" | "consumed" | "pending";
    upload?: TeamHubMessageAttachmentUpload;
  }
  interface CompositionIntent {
    createAttempted: boolean;
    removeAbortListener: () => void;
    uploads: Map<string, UploadIntent>;
  }
  const intents = new Map<string, CompositionIntent>();

  function cancelUpload(roomId: string, attachmentUploadId: string) {
    return teamHubDone(
      client.api.DELETE(
        "/v0/rooms/{roomId}/message-attachment-uploads/{attachmentUploadId}",
        { params: { path: { roomId, attachmentUploadId } } },
      ),
    );
  }

  function compositionIntent(idempotencyKey: string) {
    let intent = intents.get(idempotencyKey);
    if (!intent) {
      intent = {
        createAttempted: false,
        removeAbortListener: () => undefined,
        uploads: new Map(),
      };
      intents.set(idempotencyKey, intent);
    }
    return intent;
  }

  async function stageAttachment(input: {
    attachment: TeamHubCompositionAttachmentInput;
    idempotencyKey: string;
    onProgress?: (progress: number) => void;
    roomId: string;
    signal?: AbortSignal;
  }) {
    const intent = compositionIntent(input.idempotencyKey);
    const previous = intent.uploads.get(input.attachment.clientId);
    if (previous?.upload && previous.status === "available") {
      return previous.upload;
    }
    const attempt = previous?.attempt ?? 0;
    intent.uploads.set(input.attachment.clientId, {
      attempt: attempt + 1,
      clientId: input.attachment.clientId,
      status: "pending",
    });
    const upload = await client.uploadMessageAttachment(
      input.roomId,
      input.attachment.file,
      `${input.idempotencyKey}:attachment:${input.attachment.clientId}${
        attempt === 0 ? "" : `:retry:${attempt}`
      }`,
      {
        onProgress: input.onProgress,
        signal: input.signal,
      },
    );
    if (input.signal?.aborted) {
      await cancelUpload(input.roomId, upload.id);
      intent.uploads.delete(input.attachment.clientId);
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    intent.uploads.set(input.attachment.clientId, {
      attempt: attempt + 1,
      clientId: input.attachment.clientId,
      status: "available",
      upload,
    });
    return upload;
  }

  return {
    async cancelAttachment(input) {
      const intent = intents.get(input.idempotencyKey);
      const upload = intent?.uploads.get(input.attachmentClientId);
      if (!intent || intent.createAttempted) return;
      intent.uploads.delete(input.attachmentClientId);
      if (upload?.upload && upload.status === "available") {
        upload.status = "cancelled";
        await cancelUpload(input.roomId, upload.upload.id);
      }
      if (intent.uploads.size === 0) {
        intent.removeAbortListener();
        intents.delete(input.idempotencyKey);
      }
    },
    async createMessage(input) {
      const intent = compositionIntent(input.idempotencyKey);
      bindAbortSignal(input.signal, input.roomId, input.idempotencyKey, intent);
      if (input.signal?.aborted) {
        await cancelAvailableUploads(input.roomId, intent);
        intent.removeAbortListener();
        if (
          !intent.createAttempted &&
          intents.get(input.idempotencyKey) === intent
        ) {
          intents.delete(input.idempotencyKey);
        }
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const uploadResults = await Promise.allSettled(
        input.attachments.map((attachment) =>
          stageAttachment({
            attachment,
            idempotencyKey: input.idempotencyKey,
            onProgress: (progress) =>
              input.onAttachmentProgress?.(attachment.clientId, progress),
            roomId: input.roomId,
            signal: input.signal,
          }),
        ),
      );
      const failedUpload = uploadResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failedUpload) {
        throw failedUpload.reason;
      }
      const uploads = uploadResults.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("unreachable upload state");
        }
        return result.value;
      });

      const content = input.body.trim()
        ? createTeamHubMessageContent({
            files: [],
            mentions: input.mentions,
            documentReferences: input.documentReferences,
            skillReferences: input.skillReferences,
            text: input.body,
          })
        : { raw_message: "", segments: [] };
      intent.createAttempted = true;
      const messageInput = {
        ...content,
        ...(input.voiceLiveTurn
          ? { voice_live_turn: input.voiceLiveTurn }
          : {}),
        ...(input.contextDocumentVersionIds?.length
          ? { context_document_version_ids: input.contextDocumentVersionIds }
          : {}),
        ...(input.contextMessageIds?.length
          ? { context_message_ids: input.contextMessageIds }
          : {}),
        ...(uploads.length > 0
          ? { attachment_upload_ids: uploads.map((upload) => upload.id) }
          : {}),
      };
      // The message command may have committed before transport failure. Keep
      // the exact upload IDs for an idempotent replay.
      const message = await teamHubData(
        client.api.POST("/v0/rooms/{roomId}/messages", {
          params: {
            path: { roomId: input.roomId },
            header: idempotencyHeader(input.idempotencyKey),
          },
          body: messageInput,
        }),
      );
      for (const upload of intent.uploads.values()) {
        const uploadID = upload.upload?.id;
        if (
          uploadID &&
          uploads.some((candidate) => candidate.id === uploadID)
        ) {
          upload.status = "consumed";
        }
      }
      intent.removeAbortListener();
      intents.delete(input.idempotencyKey);
      return {
        message,
        presentation: {
          attachments: presentTeamHubMessageAttachments(message),
          mentions: input.mentions,
        },
      };
    },
    async stageAttachment(input) {
      await stageAttachment(input);
    },
  };

  async function cancelAvailableUploads(
    roomId: string,
    intent: {
      createAttempted: boolean;
      uploads: Map<string, UploadIntent>;
    },
  ) {
    if (intent.createAttempted) {
      return;
    }
    const cancellations = [] as Promise<unknown>[];
    for (const upload of intent.uploads.values()) {
      if (!upload.upload || upload.status !== "available") {
        continue;
      }
      upload.status = "cancelled";
      cancellations.push(cancelUpload(roomId, upload.upload.id));
    }
    await Promise.allSettled(cancellations);
  }

  function bindAbortSignal(
    signal: AbortSignal | undefined,
    roomId: string,
    idempotencyKey: string,
    intent: CompositionIntent,
  ) {
    intent.removeAbortListener();
    intent.removeAbortListener = () => undefined;
    if (!signal) {
      return;
    }
    const onAbort = () => {
      void cancelAvailableUploads(roomId, intent).finally(() => {
        if (intent.createAttempted) {
          return;
        }
        intent.removeAbortListener();
        if (intents.get(idempotencyKey) === intent) {
          intents.delete(idempotencyKey);
        }
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    intent.removeAbortListener = () =>
      signal.removeEventListener("abort", onAbort);
  }
}
