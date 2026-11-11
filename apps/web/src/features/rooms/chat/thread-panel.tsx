import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ComponentProps,
  type PropsWithChildren,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubMessageDocumentSegment,
  TeamHubMessageFileSegment,
  TeamHubRoom,
} from "@/features/teamhub/teamhub-types";

import { AgentAvatarStatusContext } from "../members/agent-avatar-status-context";

import { createRoomCardDecisionController } from "../cards/room-card-decision-controller";
import type { RoomCardDecision } from "../cards/room-message-card-contract";
import {
  MessageComposer,
  type MessageComposerHandle,
  type MessageComposition,
} from "./message-composer";
import {
  createDirectRoomMessagePresenter,
  withDirectRoomWireBody,
} from "./direct-room-message";
import { isTimelineMessage } from "./message-grouping";
import {
  MessageRow,
  PendingMessageRow,
  type PendingRoomMessage,
} from "./message-row";
import { AgentStreamingStatusDock } from "./message-timeline";
import { useRoomMessagePresentations } from "./room-message-presentations";
import {
  createRoomProjection,
  replaceLoadedRoomMessage,
} from "./room-projection";
import { SharedStreamingStatus } from "./shared-streaming-status";
import { useRoomChatNavigation } from "./use-room-chat-navigation";
import {
  orderRoomMessages,
  useRoomConversation,
} from "./use-room-conversation";
import { useRoomTimelineScroll } from "./use-room-timeline-scroll";
import { useDocumentCardMetadata } from "../files/use-document-card-metadata";
import { readRoomComposerDraft, writeRoomComposerDraft } from "../room-drafts";
import { RoomRejoinBanner } from "../room-participation";
import {
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomMessagesQueryKey,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";
import {
  requestThreadComposerFocus,
  subscribeThreadComposerFocus,
  threadComposerFocusRequest,
} from "./thread-composer-focus";
import { ThreadTimeline } from "./thread-timeline";
import { roomMessageSender } from "./room-message-sender";

const emptyAgentStatuses = new Map();
const emptyActors: TeamHubActorRef[] = [];
const emptyMessages: TeamHubMessage[] = [];
const ignoreProfile = () => undefined;

interface ThreadPanelProps {
  accountId: string;
  mentionOptions?: TeamHubActorRef[];
  onOpenProfile?: (actorId: string) => void;
  onRoomResolved?: (roomId: string | undefined) => void;
  /** Mentions the parent Room presented for the root Message. */
  rootMentions?: TeamHubActorRef[];
  rootMessage: TeamHubMessage;
  tenantId: string;
}

export function ThreadPanel(props: ThreadPanelProps) {
  return <ThreadPanelContent {...props} key={props.rootMessage.id} />;
}

function ThreadPanelContent({
  accountId,
  mentionOptions = emptyActors,
  onOpenProfile = ignoreProfile,
  onRoomResolved,
  rootMentions = emptyActors,
  rootMessage,
  tenantId,
}: ThreadPanelProps) {
  const { client } = useTeamHubRuntime();
  const composition = roomMessageSender(client);
  const parentRoomId = rootMessage.room_id;
  const parentRoom = useQuery(roomQueryOptions(client, tenantId, parentRoomId));
  const directPeer = parentRoom.data?.direct_peer;
  const participating = parentRoom.data?.participation !== "left";
  const threadRoomId = useThreadRoom(rootMessage, participating, tenantId);
  useEffect(() => {
    onRoomResolved?.(threadRoomId);
  }, [onRoomResolved, threadRoomId]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const composerRef = useRef<MessageComposerHandle>(null);
  const composerFocusRequested =
    useSyncExternalStore(
      subscribeThreadComposerFocus,
      threadComposerFocusRequest,
    ) === rootMessage.id;
  const identity = useQuery(teamHubIdentityQueryOptions(client)).data;
  const currentActorId = identity?.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const rowContext = useThreadRowContext(
    client,
    tenantId,
    parentRoomId,
    mentionOptions,
  );
  const navigation = useRoomChatNavigation(client, tenantId, parentRoomId);
  const draftScope = {
    accountId,
    roomId: parentRoomId,
    tenantId,
    threadId: rootMessage.id,
  };
  const [initialDraft] = useState(() => readRoomComposerDraft(draftScope));
  const messagesQuery = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, threadRoomId ?? ""),
    enabled: Boolean(threadRoomId),
  });
  const threadOpening = !threadRoomId || messagesQuery.isPending;
  const messages = useMemo(
    () =>
      threadRoomId && messagesQuery.data
        ? orderRoomMessages(messagesQuery.data.pages)
        : emptyMessages,
    [messagesQuery.data, threadRoomId],
  );
  const conversation = useRoomConversation({
    client,
    composition,
    currentActorId,
    directPeerAgentId:
      parentRoom.data?.kind === "direct" &&
      parentRoom.data.direct_peer?.kind === "agent"
        ? parentRoom.data.direct_peer.id
        : undefined,
    enabled: participating,
    messages,
    messagesQueryKey: roomMessagesQueryKey(tenantId, threadRoomId ?? ""),
    openLiveActivity: (agent, runStatusId, runId) =>
      navigation.openLiveActivity(
        agent,
        runStatusId,
        runId,
        threadRoomId,
        rootMessage.id,
      ),
    outboxScope: { accountId, roomId: threadRoomId ?? "", tenantId },
    roomId: threadRoomId ?? "",
    tenantId,
  });
  const decideCard = useThreadCardDecision(threadRoomId, tenantId);
  useEffect(() => {
    // A restored Thread can finish loading after the user starts typing.
    if (
      document.activeElement?.matches(
        "input, textarea, [contenteditable='true']",
      )
    )
      return;
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // "Reply to thread" asks to write; wait until the composer is enabled.
    if (!composerFocusRequested || !threadRoomId) return;
    requestThreadComposerFocus(null);
    if (window.matchMedia("(pointer: coarse)").matches) return;
    composerRef.current?.focus();
  }, [composerFocusRequested, threadRoomId]);

  const replies = useMemo(() => messages.filter(isTimelineMessage), [messages]);
  const present = useMemo(
    () => createDirectRoomMessagePresenter(directPeer),
    [directPeer],
  );
  const presentedRoot = useMemo(
    () => present(rootMessage),
    [present, rootMessage],
  );
  const presentedReplies = useMemo(
    () => replies.map(present),
    [present, replies],
  );
  const threadMessages = useMemo(
    () => [rootMessage, ...replies],
    [replies, rootMessage],
  );
  const rootPresentations = useMemo(
    () => ({ [rootMessage.id]: { attachments: [], mentions: rootMentions } }),
    [rootMentions, rootMessage.id],
  );
  const presentations = useRoomMessagePresentations({
    deliveryPresentations: conversation.delivery.presentations,
    mentionOptions,
    messages: threadMessages,
    roomMessagePresentations: rootPresentations,
  });
  const documentMetadata = useDocumentCardMetadata(
    client,
    tenantId,
    [],
    threadMessages,
  );
  const documentTitles = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(documentMetadata).map(([id, document]) => [
          id,
          document.title,
        ]),
      ),
    [documentMetadata],
  );
  const timeline = useRoomTimelineScroll({
    firstMessageId: replies[0]?.id,
    linkedMessageId: null,
    messageCount: threadMessages.length,
    pendingMessageCount: conversation.pendingMessages.length,
  });

  async function loadEarlierReplies() {
    timeline.prepareForOlderMessages();
    const result = await messagesQuery.fetchNextPage();
    timeline.cancelOlderMessagesIfUnchanged(
      result.data
        ? orderRoomMessages(result.data.pages).find(isTimelineMessage)?.id
        : undefined,
    );
  }

  function sendReply(value: MessageComposition) {
    if (!threadRoomId || !participating) return;
    timeline.pinToLatest();
    void conversation.delivery.sendMessage(
      withDirectRoomWireBody(value, directPeer),
    );
  }

  function renderMessage(
    message: TeamHubMessage,
    showAuthor: boolean,
    reply: boolean,
  ) {
    return (
      <AgentAvatarStatusContext.Provider
        value={{
          statuses: emptyAgentStatuses,
          onOpenProfile,
          onOpenActivityLog: (actorId) =>
            navigation.openAgentActivity(
              {
                id: actorId,
                display_name: rowContext.actorDisplayNames[actorId] ?? "Agent",
              },
              message.room_id,
            ),
        }}
      >
        <MessageRow
          actorDisplayNames={rowContext.actorDisplayNames}
          actorKinds={rowContext.actorKinds}
          canMentionAuthor={rowContext.mentionableIds.has(message.author.id)}
          currentActorId={currentActorId}
          documentMetadata={documentMetadata}
          documentTitles={documentTitles}
          isAuthorMember={rowContext.memberIds.has(message.author.id)}
          message={message}
          onCardDecision={decideCard}
          onMentionAuthor={
            participating
              ? (actor) => composerRef.current?.insertMention(actor)
              : undefined
          }
          onOpenArtifact={navigation.previewArtifact}
          onOpenMessageFile={(segment) => openMessageFile(navigation, segment)}
          onOpenProfile={onOpenProfile}
          onToggleReaction={
            reply && threadRoomId && participating
              ? conversation.toggleReaction
              : undefined
          }
          presentation={presentations[message.id]}
          showAuthor={showAuthor}
          tenantId={tenantId}
          workspaceAgentIds={rowContext.workspaceAgentIds}
        />
      </AgentAvatarStatusContext.Provider>
    );
  }

  return (
    <aside
      aria-label="Message Thread"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col app-work-surface"
    >
      <h2 className="sr-only" ref={headingRef} tabIndex={-1}>
        Thread
      </h2>
      <ThreadTimeline
        canLoadEarlier={messagesQuery.hasNextPage}
        hasPending={conversation.pendingMessages.length > 0}
        loadingEarlier={messagesQuery.isFetchingNextPage}
        onLoadEarlier={() => void loadEarlierReplies()}
        opening={threadOpening}
        renderMessage={renderMessage}
        replies={presentedReplies}
        rootMessage={presentedRoot}
        timeline={timeline}
      >
        <ThreadPendingReplies
          actorId={currentActorId}
          actorName={
            rowContext.actorDisplayNames[currentActorId ?? ""] ?? "You"
          }
          lastAuthorId={replies.at(-1)?.author.id}
          messages={conversation.pendingMessages}
          onCancel={conversation.delivery.cancelMessage}
          onOpenProfile={onOpenProfile}
          onRetry={conversation.delivery.retryMessage}
        />
      </ThreadTimeline>
      <ThreadReplyDock
        dock={threadRoomId ? conversation.dock : undefined}
        outboxError={conversation.delivery.outboxError}
        parentRoom={parentRoom.data}
      >
        <MessageComposer
          ariaLabel="Reply in Thread"
          disabled={!threadRoomId}
          initialMentions={initialDraft.mentions}
          initialValue={initialDraft.body}
          mentionOptions={mentionOptions}
          onDraftStateChange={(draft) =>
            writeRoomComposerDraft(draftScope, draft)
          }
          onSend={sendReply}
          placeholder={
            threadRoomId ? "Reply in this Thread" : "Opening Thread…"
          }
          ref={composerRef}
        />
      </ThreadReplyDock>
    </aside>
  );
}

function ThreadReplyDock({
  children,
  dock,
  outboxError,
  parentRoom,
}: PropsWithChildren<{
  /** Present once the Thread Room exists. */
  dock?: ComponentProps<typeof AgentStreamingStatusDock>;
  outboxError?: string;
  parentRoom?: TeamHubRoom;
}>) {
  if (parentRoom?.participation === "left") {
    return <RoomRejoinBanner room={parentRoom} />;
  }
  return (
    <div className="room-composer-dock shrink-0 px-3">
      {outboxError ? (
        <p className="mb-2 text-sm text-app-danger" role="alert">
          {outboxError}
        </p>
      ) : null}
      <SharedStreamingStatus surface="thread">
        {dock ? <AgentStreamingStatusDock {...dock} /> : null}
      </SharedStreamingStatus>
      {children}
    </div>
  );
}

/** Opens the Thread Room on first view and follows its Room Events. */
function useThreadRoom(
  rootMessage: TeamHubMessage,
  participating: boolean,
  tenantId: string,
) {
  const { client, events } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [threadRoomId, setThreadRoomId] = useState(rootMessage.thread?.room_id);
  const projection = useMemo(
    () =>
      threadRoomId
        ? createRoomProjection({
            initialRoomSeq: 0,
            messages: client,
            queryClient,
            roomId: threadRoomId,
            tenantId,
          })
        : null,
    [client, queryClient, tenantId, threadRoomId],
  );

  useEffect(() => {
    if (threadRoomId || !participating) return;
    let cancelled = false;
    void teamHubData(
      client.api.POST("/v0/rooms/{roomId}/messages/{messageId}/thread", {
        params: {
          path: { roomId: rootMessage.room_id, messageId: rootMessage.id },
        },
      }),
    )
      .then((result) => {
        if (!cancelled) setThreadRoomId(result.room.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    client,
    participating,
    rootMessage.id,
    rootMessage.room_id,
    threadRoomId,
  ]);

  useEffect(() => {
    if (!threadRoomId || !projection || !participating) return;
    return events.subscribeRoom({
      applyEvent: (event) => projection.applyEvent(event),
      getLastAppliedRoomSeq: projection.getLastAppliedRoomSeq,
      onRoomInvalidated: () => undefined,
      roomId: threadRoomId,
    });
  }, [events, participating, projection, threadRoomId]);

  return threadRoomId;
}

/** A Thread's cards belong to its replies, so they are decided in the Thread
 * Room. */
function useThreadCardDecision(
  threadRoomId: string | undefined,
  tenantId: string,
) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const controller = useMemo(
    () =>
      threadRoomId
        ? createRoomCardDecisionController({
            client,
            onResolved: (message) =>
              replaceLoadedRoomMessage(
                queryClient,
                tenantId,
                threadRoomId,
                message,
              ),
            roomId: threadRoomId,
            tenantId,
          })
        : undefined,
    [client, queryClient, tenantId, threadRoomId],
  );

  return async (decision: RoomCardDecision) => {
    if (!controller) throw new Error("Thread is still opening.");
    await controller.decide(decision);
  };
}

function ThreadPendingReplies({
  actorId,
  actorName,
  lastAuthorId,
  messages,
  onCancel,
  onOpenProfile,
  onRetry,
}: {
  actorId?: string;
  actorName: string;
  lastAuthorId?: string;
  messages: PendingRoomMessage[];
  onCancel: (clientId: string) => Promise<void> | void;
  onOpenProfile: (actorId: string) => void;
  onRetry: (clientId: string) => void;
}) {
  return messages.map((message, index) => (
    <PendingMessageRow
      actorId={actorId}
      actorName={actorName}
      key={message.clientId}
      message={message}
      onCancel={onCancel}
      onOpenProfile={onOpenProfile}
      onRetry={onRetry}
      startsGroup={index === 0 && lastAuthorId !== actorId}
    />
  ));
}

/** Thread rows read the parent Room's actors, members, and Agents. */
function useThreadRowContext(
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
  mentionOptions: TeamHubActorRef[],
) {
  const actors = useQuery(tenantActorsQueryOptions(client, tenantId)).data
    ?.items;
  const agents = useQuery(tenantAgentsQueryOptions(client, tenantId)).data
    ?.items;
  const members = useQuery(roomMembersQueryOptions(client, tenantId, roomId))
    .data?.items;
  return useMemo(
    () => ({
      actorDisplayNames: Object.fromEntries(
        (actors ?? []).map((actor) => [actor.id, actor.display_name]),
      ),
      actorKinds: Object.fromEntries(
        (actors ?? []).map((actor) => [actor.id, actor.kind]),
      ),
      memberIds: new Set((members ?? []).map((member) => member.actor.id)),
      mentionableIds: new Set(mentionOptions.map((actor) => actor.id)),
      workspaceAgentIds: new Set(
        (agents ?? []).flatMap((agent) =>
          agent.visibility_scope === "workspace" ? [agent.actor.id] : [],
        ),
      ),
    }),
    [actors, agents, members, mentionOptions],
  );
}

function openMessageFile(
  navigation: ReturnType<typeof useRoomChatNavigation>,
  segment: TeamHubMessageFileSegment | TeamHubMessageDocumentSegment,
) {
  void navigation.openMessageFile(segment);
}
