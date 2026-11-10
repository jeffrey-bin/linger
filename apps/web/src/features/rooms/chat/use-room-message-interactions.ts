import { useMemo, useRef, useState } from "react";

import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import type { MessageComposerHandle } from "./message-composer";

export function useRoomMessageInteractions(input: {
  currentActorId?: string;
  mentionOptions: TeamHubActorRef[];
  roomId: string;
  tenantId: string;
}) {
  const composerRef = useRef<MessageComposerHandle>(null);
  const scopeKey = `${input.tenantId}\u0000${input.roomId}`;
  const [contextSelection, setContextSelection] = useState<{
    messages: TeamHubMessage[];
    scopeKey: string;
  }>({ messages: [], scopeKey });
  if (contextSelection.scopeKey !== scopeKey) {
    setContextSelection({ messages: [], scopeKey });
  }
  const selectedContextMessages =
    contextSelection.scopeKey === scopeKey ? contextSelection.messages : [];

  const actions = useMemo(() => {
    function updateContextSelection(
      update: (current: TeamHubMessage[]) => TeamHubMessage[],
    ) {
      setContextSelection((current) => {
        // An old send completion must not touch the next Room's draft context.
        if (current.scopeKey !== scopeKey) return current;
        const messages = update(current.messages);
        if (
          messages.length === current.messages.length &&
          messages.every(
            (message, index) => message === current.messages[index],
          )
        ) {
          return current;
        }
        return { messages, scopeKey };
      });
    }

    function replyToMessage(message: TeamHubMessage) {
      updateContextSelection(() => [message]);
      if (
        input.mentionOptions.some((actor) => actor.id === message.author.id) &&
        message.author.id !== input.currentActorId
      ) {
        composerRef.current?.insertMention(message.author);
      } else {
        composerRef.current?.focus();
      }
    }

    return {
      clearContext: (messageIds?: readonly string[]) =>
        updateContextSelection((current) => {
          if (messageIds === undefined) return [];
          const cleared = new Set(messageIds);
          return current.filter((message) => !cleared.has(message.id));
        }),
      composerRef,
      mentionAuthor: (actor: TeamHubActorRef) =>
        composerRef.current?.insertMention(actor),
      removeContext: (messageId: string) =>
        updateContextSelection((current) =>
          current.filter((message) => message.id !== messageId),
        ),
      replyToMessage,
    };
  }, [scopeKey, input.currentActorId, input.mentionOptions]);
  return { ...actions, selectedContextMessages };
}
