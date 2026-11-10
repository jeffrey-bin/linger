// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { roomMessageSender } from "../room-message-sender";
import {
  createHttpTeamHubClient,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";
import type {
  TeamHubMessage,
  TeamHubMessageCreateInput,
} from "@/features/teamhub/teamhub-types";
import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { tenantRoomActivityQueryKey } from "../../room-queries";
import {
  readRoomComposerDraft,
  writeRoomComposerDraft,
} from "../../room-drafts";
import {
  keepUnsentVoiceText,
  sendVoiceTurnToRoom,
} from "./voice-mode-room-sender";

const agent = {
  display_name: "Codex",
  id: "agent-codex",
  kind: "agent" as const,
  tenant_id: "tenant-1",
};
const target = {
  accountId: "account-1",
  recipient: agent,
  roomId: "room-voice",
  roomName: "Codex",
  tenantId: "tenant-1",
};
const scope = {
  accountId: "account-1",
  roomId: "room-voice",
  tenantId: "tenant-1",
};
const prefix = { body: "", documentReferences: [], mentions: [] };

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createTestStorage(),
  });
});

function sentMessage(): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Jenny",
      id: "human-1",
      kind: "human",
      tenant_id: "tenant-1",
    },
    created_at: new Date().toISOString(),
    id: "message-1",
    message_kind: "conversation",
    raw_message: "@Codex Explain",
    room_id: "room-voice",
    segments: [],
    tenant_id: "tenant-1",
  } as unknown as TeamHubMessage;
}

describe("sendVoiceTurnToRoom", () => {
  it("sends Message excerpts with the turn and leaves Document material for the Room", async () => {
    writeRoomComposerDraft(scope, {
      ...readRoomComposerDraft(scope),
      voiceMaterials: [
        {
          id: "m1",
          messageId: "message-0",
          title: "Alex",
          quote: "Ship Friday",
        },
        { id: "d1", documentId: "doc-plan", title: "Plan", quote: "Scope" },
      ],
    });
    const createMessage = vi.fn<TestRouteHandler>(() => sentMessage());
    const { client, server } = messageClient(createMessage);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await sendVoiceTurnToRoom({
      composition: roomMessageSender(client),
      eventId: "turn-9",
      prefix,
      queryClient,
      target,
      text: "Explain",
    });

    expect(createMessage).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: tenantRoomActivityQueryKey(target.tenantId),
    });
    const [{ body, params }] = createMessage.mock.calls[0]!;
    const content = body as TeamHubMessageCreateInput;
    expect(params.roomId).toBe("room-voice");
    expect(
      server
        .requestsTo("POST", "/v0/rooms/{roomId}/messages")[0]
        ?.headers.get("Idempotency-Key"),
    ).toBe("voice-mode:turn-9");
    expect(content.raw_message).toContain("> Ship Friday");
    expect(content.raw_message).toContain("Explain");
    expect(content.raw_message).not.toContain("Scope");
    expect(content.segments).toContainEqual(
      expect.objectContaining({ type: "reference", target: agent.id }),
    );
    expect(readRoomComposerDraft(scope).voiceMaterials).toEqual([
      { id: "d1", documentId: "doc-plan", title: "Plan", quote: "Scope" },
    ]);
  });

  it("keeps material for a retry when the send fails", async () => {
    writeRoomComposerDraft(scope, {
      ...readRoomComposerDraft(scope),
      voiceMaterials: [
        {
          id: "m1",
          messageId: "message-0",
          title: "Alex",
          quote: "Ship Friday",
        },
      ],
    });
    await expect(
      sendVoiceTurnToRoom({
        composition: roomMessageSender(
          messageClient(() => {
            throw new Error("offline");
          }).client,
        ),
        eventId: "turn-9",
        prefix,
        queryClient: undefined,
        target,
        text: "Explain",
      }),
    ).rejects.toBeInstanceOf(TeamHubTransportError);
    expect(readRoomComposerDraft(scope).voiceMaterials).toHaveLength(1);
  });

  it("returns unsent words to the Room draft after the prefix", () => {
    keepUnsentVoiceText(target, { ...prefix, body: "@Plan" }, "and then");
    expect(readRoomComposerDraft(scope).body).toBe("@Plan\nand then");
  });
});

function messageClient(createMessage: TestRouteHandler) {
  const server = new TeamHubTestServer().on(
    "POST",
    "/v0/rooms/{roomId}/messages",
    createMessage,
  );
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client, server };
}

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}
