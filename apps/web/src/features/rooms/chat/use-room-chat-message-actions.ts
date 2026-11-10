import type { MessageComposition } from "@/features/rooms/chat/message-composer";
import { withDirectRoomWireBody } from "@/features/rooms/chat/direct-room-message";
import type {
  TeamHubMessage,
  TeamHubRoom,
} from "@/features/teamhub/teamhub-types";

export function createRoomChatMessageActions(input: {
  delivery: {
    // Accept the Room delivery helper without re-declaring its full composition type.
    enqueueMessage: (
      value: never,
    ) => Promise<{ ok: true } | { ok: false; error: unknown }>;
    sendMessage: (
      value: never,
    ) => Promise<{ ok: true } | { ok: false; error: unknown }>;
  };
  messages: {
    fetchNextPage: () => Promise<{
      data?: { pages: Array<{ items: TeamHubMessage[] }> };
    }>;
  };
  room: TeamHubRoom;
  selectedContextMessages: TeamHubMessage[];
  timeline: {
    cancelOlderMessagesIfUnchanged: (id: string | undefined) => void;
    prepareForOlderMessages: () => void;
  };
}) {
  async function loadOlderMessages() {
    input.timeline.prepareForOlderMessages();
    const result = await input.messages.fetchNextPage();
    const nextFirstMessageId = result.data?.pages
      .slice()
      .reverse()
      .flatMap((page) => page.items)[0]?.id;
    input.timeline.cancelOlderMessagesIfUnchanged(nextFirstMessageId);
  }

  async function sendMessage(value: MessageComposition) {
    const deliver = value.messageIdempotencyKey
      ? input.delivery.sendMessage
      : input.delivery.enqueueMessage;
    const outcome = await deliver({
      ...withDirectRoomWireBody(value, input.room.direct_peer),
      contextMessages: value.contextMessages ?? input.selectedContextMessages,
    } as never);
    if (!outcome.ok) throw outcome.error;
  }

  return {
    loadOlderMessages,
    sendMessage,
  };
}
