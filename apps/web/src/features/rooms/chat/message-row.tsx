/* oxlint-disable react-doctor/no-giant-component -- ConversationMessageRow still owns card, attachment, Thread, and runtime presentation; splitting that ownership is a separate refactor. */
import {
  AlarmClockIcon,
  AtIcon,
  Cancel01Icon,
  Copy01Icon,
  MailReply01Icon,
  Message01Icon,
  MoreHorizontalIcon,
  RotateLeft01Icon,
  SentIcon,
  SmilePlusIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FileTypeIcon } from "@/features/library/workspace-file-icon";
import { isDocumentCardSegment } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubDocumentPreviewTarget,
  TeamHubMessagePresentation,
  TeamHubPresentedAttachment,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubMessageDocumentSegment,
  TeamHubMessageFileSegment,
  TeamHubMessageReactionId,
} from "@/features/teamhub/teamhub-types";

import type { RoomCardDecision } from "../cards/room-message-card-contract";
import {
  knownRoomMessageCard,
  RoomMessageCard,
} from "../cards/room-message-card";
import {
  documentCardPresentation,
  type DocumentCardMetadata,
} from "../files/document-card-metadata";
import { cn } from "@/lib/cn";
import { artifactFileTypeLabel } from "../files/artifact-file-kind";
import { MessageFileAttachment } from "../files/message-file-attachment";
import { selectArtifactRenderer } from "../files/artifact-renderer-policy";
import { chatImageSize, useDecodedImage } from "../files/local-message-images";
import {
  artifactTreeDetail,
  fileItemDetail,
  MessageFileItem,
} from "../files/message-file-item";
import { ActorAvatar } from "../members/actor-avatar";
import { AgentStatusAvatar } from "../members/agent-status-avatar";
import { useRoomRenderTiming } from "../room-render-timing";
import {
  messageBodyBlocks,
  messageBodyRuns,
  type MessageTextBlock,
} from "./message-body-blocks";
import { MessageCard } from "./message-card";
import { MessageHtmlFragment } from "./message-html-fragment";
import { MessageMarkdown } from "./message-markdown";
import { MessageReactionBar } from "./message-reactions/message-reaction-bar";
import { MessageReactionPicker } from "./message-reactions/message-reaction-picker";
import {
  ReactionCheerBurst,
  useReactionCheer,
  type ReactionCheer,
} from "./message-reactions/reaction-cheer";
import {
  hasOwnReaction,
  messageSupportsReactions,
} from "./message-reactions/reaction-state";
import { applySearchTermHighlight } from "./search-term-highlight";
import { settledCardNotice } from "../cards/card-notice";
import { CardNoticeRows } from "./card-notice-rows";
import { ReplyContext } from "./reply-context";
import { RoomNoticeRow } from "./room-notice-row";
import { ThreadReplyPreview } from "./thread-reply-preview";
import { ownSendStartedAt } from "./recent-own-sends";

// Matches --chat-pop-duration.
const OWN_ENTRANCE_MS = 450;
const SENDING_NOTICE_DELAY_MS = 1000;
const EMPTY_ACTOR_KINDS: Readonly<Record<string, "human" | "agent">> = {};

export interface PendingRoomMessage {
  attachments: Array<{
    clientId: string;
    error?: string;
    file: File;
    filename: string;
    progress: number;
    sizeBytes: number;
    status: "failed" | "ready" | "staging";
  }>;
  body: string;
  contextMessages: TeamHubMessage[];
  clientId: string;
  // Epoch milliseconds of the first send; retries keep it.
  createdAt: number;
  error?: string;
  mentions: TeamHubActorRef[];
  status: "failed" | "sending" | "unknown";
}

interface MessageRowProps {
  actorDisplayNames: Readonly<Record<string, string>>;
  currentActorId?: string;
  canMentionAuthor?: boolean;
  isAuthorMember?: boolean;
  documentTitles: Readonly<Record<string, string>>;
  documentMetadata: Readonly<Record<string, DocumentCardMetadata>>;
  message: TeamHubMessage;
  messageFilePreview?: "enabled" | "disabled";
  onCardDecision: (decision: RoomCardDecision) => Promise<void> | void;
  onOpenArtifact: (document: TeamHubDocumentPreviewTarget) => void;
  onOpenMessageFile: (
    segment: TeamHubMessageFileSegment | TeamHubMessageDocumentSegment,
  ) => void;
  onOpenProfile: (actorId: string) => void;
  /** Opens the Direct Room with an Agent a Room notice names. */
  onOpenDirectChat?: (actorId: string) => void;
  onOpenUrl?: (url: string) => void;
  onOpenThread?: (
    message: TeamHubMessage,
    options?: { focusComposer?: boolean },
  ) => void;
  onMentionAuthor?: (actor: TeamHubActorRef) => void;
  onForwardMessage?: (message: TeamHubMessage) => void;
  onReply?: (message: TeamHubMessage) => void;
  onToggleReaction?: (
    message: TeamHubMessage,
    reactionId: TeamHubMessageReactionId,
  ) => Promise<void>;
  actorKinds?: Readonly<Record<string, "human" | "agent">>;
  presentation?: TeamHubMessagePresentation;
  tenantId: string;
  selectedAsContext?: boolean;
  /** Arrived after the Room opened, so it lifts in on its own. */
  entering?: boolean;
  showAuthor?: boolean;
  focused?: boolean;
  /** Keyword the global search matched; shown as selected text while focused. */
  focusHighlight?: string | null;
  workspaceAgentIds: ReadonlySet<string>;
}

export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message } = props;

  if (message.card_context_message_id) return null;
  if (message.message_kind === "room_notice") {
    return (
      <RoomNoticeRow
        currentActorId={props.currentActorId}
        entering={props.entering}
        message={message}
        onOpenDirectChat={props.onOpenDirectChat}
        onOpenProfile={props.onOpenProfile}
      />
    );
  }

  // A settled card reads as system lines: the card eases shut, then its line
  // fades in. A card that was settled when it loaded just shows the line.
  const card = knownRoomMessageCard(message.card);
  const notice = card ? settledCardNotice(card, props.currentActorId) : null;
  if (card) {
    return (
      <AnimatePresence initial={false} mode="wait">
        {notice ? (
          <motion.div
            animate={{ opacity: 1 }}
            initial={{ opacity: 0 }}
            key="notice"
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <CardNotice notice={notice} props={props} />
          </motion.div>
        ) : (
          <motion.div
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            key="card"
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <ConversationMessageRow {...props} />
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return <ConversationMessageRow {...props} />;
});

/** A settled card's system line. */
function CardNotice({
  notice,
  props,
}: {
  notice: NonNullable<ReturnType<typeof settledCardNotice>>;
  props: MessageRowProps;
}) {
  return <CardNoticeRows notice={notice} tenantId={props.tenantId} />;
}

const EMPTY_MESSAGE_MENTIONS: TeamHubActorRef[] = [];
const EMPTY_ATTACHMENTS: TeamHubPresentedAttachment[] = [];

function ConversationMessageRow({
  actorDisplayNames,
  currentActorId,
  canMentionAuthor = false,
  isAuthorMember = false,
  entering = false,
  showAuthor = true,
  documentTitles,
  documentMetadata,
  message,
  messageFilePreview = "enabled",
  onCardDecision,
  onOpenArtifact,
  onOpenMessageFile,
  onOpenProfile,
  onOpenUrl,
  onOpenThread,
  onMentionAuthor,
  onForwardMessage,
  onReply,
  onToggleReaction,
  actorKinds = EMPTY_ACTOR_KINDS,
  presentation,
  tenantId,
  selectedAsContext = false,
  focused = false,
  focusHighlight,
  workspaceAgentIds,
}: MessageRowProps) {
  const rowRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused || !focusHighlight) return;
    const body = rowRef.current?.querySelector(".message-row-body");
    if (!body) return;
    return applySearchTermHighlight(body, focusHighlight);
  }, [focused, focusHighlight, message.raw_message, message.segments]);
  const isAgent = message.author.kind === "agent";
  const isOwn = message.author.id === currentActorId;
  // The entrance this browser's own send already began, measured once.
  const [ownEntranceElapsed] = useState(() => {
    const sentAt = isOwn ? ownSendStartedAt(message.id) : undefined;
    const elapsed = sentAt === undefined ? Infinity : Date.now() - sentAt;
    return elapsed < OWN_ENTRANCE_MS ? elapsed : undefined;
  });
  const authorName =
    actorDisplayNames[message.author.id] ?? message.author.display_name;
  const card = knownRoomMessageCard(message.card);
  // Only a card sent as the Personal Profile delivery (card_kind) links to
  // Wiki Profile; the body's wording never decides it.
  const profileDelivery =
    isAgent && currentActorId && message.card_kind === "profile"
      ? {
          actorId: currentActorId,
          wikiPath: `/t/${encodeURIComponent(tenantId)}/library/wiki`,
          tenantId,
          roomId: message.room_id,
          authorId: message.author.id,
        }
      : undefined;
  const hasCardPayload = message.card !== undefined;
  const [reactionError, setReactionError] = useState(false);
  const { cheer, cheerOnAdd } = useReactionCheer();
  const toggleReaction =
    onToggleReaction && currentActorId && messageSupportsReactions(message)
      ? (reactionId: TeamHubMessageReactionId) => {
          setReactionError(false);
          if (isAgent && !hasOwnReaction(message, reactionId, currentActorId)) {
            cheerOnAdd(reactionId);
          }
          void onToggleReaction(message, reactionId).catch(() =>
            setReactionError(true),
          );
        }
      : undefined;
  const bodyBlocks = useMemo(
    () => messageBodyBlocks(message.segments),
    [message.segments],
  );
  const firstProfileBlock = profileDelivery && bodyBlocks[0];
  const profileParts =
    firstProfileBlock &&
    firstProfileBlock.kind === "text" &&
    !firstProfileBlock.segments
      ? /^([^\n]{1,120})\n\s*\n([\s\S]+)$/.exec(firstProfileBlock.body)
      : null;
  useRoomRenderTiming(
    "message",
    isAgent && !card && bodyBlocks.some((block) => block.kind === "text")
      ? { roomId: message.room_id, messageId: message.id, result: "rendered" }
      : null,
    JSON.stringify(
      bodyBlocks.flatMap((block) =>
        block.kind === "text" ? [block.body] : [],
      ),
    ),
  );
  const hasHtmlFragment = bodyBlocks.some(
    (block) => block.kind === "html_fragment",
  );
  // Cards and inline HTML take the full lane on narrow screens.
  const wideCard = Boolean(card || message.card_title || hasHtmlFragment);
  const reactionBar = messageSupportsReactions(message) ? (
    <MessageReactionBar
      actorDisplayNames={actorDisplayNames}
      actorKinds={actorKinds}
      currentActorId={currentActorId}
      error={reactionError}
      message={message}
      onToggle={toggleReaction}
    />
  ) : null;
  const reactionsUnderBubble = Boolean(
    reactionBar && message.reactions?.length,
  );
  const messageActions = (
    <ConversationMessageActions
      currentActorId={currentActorId}
      hasCardPayload={hasCardPayload}
      message={message}
      onToggleReaction={toggleReaction}
      onOpenThread={onOpenThread}
      onForwardMessage={onForwardMessage}
      onReply={onReply}
    />
  );
  const presentationAttachments = Array.isArray(presentation?.attachments)
    ? presentation.attachments
    : EMPTY_ATTACHMENTS;
  const attachmentByDocument = new Map(
    presentationAttachments.map((attachment) => [
      attachment.document.id,
      attachment,
    ]),
  );
  const presentationMentions = Array.isArray(presentation?.mentions)
    ? presentation.mentions
    : EMPTY_MESSAGE_MENTIONS;
  const documentSegments = useMemo(
    () =>
      message.segments.filter(
        (segment): segment is TeamHubMessageDocumentSegment =>
          segment.type === "document" && !isDocumentCardSegment(segment),
      ),
    [message.segments],
  );
  // A typed card shows its own content, and a delivery card only its title,
  // so neither shows the Message text; their files still show once each.
  const bodyRuns = messageBodyRuns(
    card || message.card_title
      ? bodyBlocks.filter((block) => block.kind !== "text")
      : bodyBlocks,
    presentationAttachments,
  );
  const firstBubbleIndex = bodyRuns.findIndex((run) => run.kind === "bubble");
  // Text sits in a bubble, a Human's and an Agent's alike; its actions center
  // on that bubble alone.
  const bubbled = firstBubbleIndex >= 0;
  // As before: Reactions straddle the text bubble, and anything shown
  // outside it follows below.
  const reactionsOnBubble = bubbled;

  const renderText = (block: MessageTextBlock) => (
    <div
      className={cn(
        "message-row-body text-app-ink",
        // A new Agent reply's words sweep in once its bubble has popped; a
        // card and a person's own words only pop.
        entering && isAgent && !card && "message-text-sweep",
      )}
      key={`text:${block.body}`}
    >
      <MessageMarkdown
        authorKind={message.author.kind}
        body={block.body}
        segments={block.segments}
        documentReferences={documentSegments}
        documentTitles={documentTitles}
        mentions={presentationMentions}
        onOpenActor={onOpenProfile}
        onOpenUrl={onOpenUrl}
        onOpenDocument={(document) =>
          onOpenMessageFile({
            ...document,
            content:
              documentTitles[document.document_id] ?? document.content.slice(1),
          })
        }
      />
    </div>
  );
  // What a Document-backed file shows: its current Document metadata when
  // known, otherwise the name it was attached under.
  const documentFile = (documentId: string, attachedName: string) => {
    const metadata = documentMetadata[documentId];
    const attachment = attachmentByDocument.get(documentId);
    return {
      ...(metadata
        ? documentCardPresentation(metadata)
        : { filename: attachedName }),
      disabled: attachment ? !attachment.available : false,
      documentId,
      previewEnabled: messageFilePreview === "enabled",
      sizeBytes: attachment?.sizeBytes,
    };
  };
  const renderBlock = (
    block: Exclude<(typeof bodyBlocks)[number], MessageTextBlock>,
  ) => {
    if (block.kind === "artifact_tree") {
      const {
        entry_document_id: entryId,
        entry_document_version_id: entryVersionId,
      } = block.segment;
      return (
        <MessageFileItem
          actionLabel="Preview"
          detail={artifactTreeDetail(block.segment)}
          key={block.segment.publication_group_id}
          name={block.segment.root_path}
          onOpen={
            entryId && entryVersionId
              ? () =>
                  onOpenArtifact({
                    current_version: { id: entryVersionId },
                    id: entryId,
                    title: block.segment.root_path,
                  })
              : undefined
          }
          visual={<FileTypeIcon filename={block.segment.root_path} folder />}
        />
      );
    }
    if (block.kind === "html_fragment") {
      return (
        <MessageHtmlFragment
          html={block.segment.html}
          key={`html-fragment:${block.segment.content}:${block.segment.html.length}:${block.segment.html.slice(0, 32)}`}
          title={block.segment.content}
        />
      );
    }
    if (block.kind === "document_card") {
      const metadata = documentMetadata[block.segment.document_id];
      // An attached file already knows its type and version, so it shows as
      // what it is before the Document metadata arrives.
      const attachment = attachmentByDocument.get(block.segment.document_id);
      return (
        <MessageFileAttachment
          {...documentFile(block.segment.document_id, block.segment.content)}
          // A live Document opens in its editor rather than previewing.
          actionLabel={metadata?.format === "blocknote" ? "Open" : undefined}
          key={block.segment.document_id}
          mediaType={metadata?.version?.media_type ?? attachment?.mediaType}
          onOpen={() => onOpenMessageFile(block.segment)}
          sourceFilename={
            metadata?.version?.filename ??
            attachment?.filename ??
            `document.${metadata?.representation_format}`
          }
          versionId={
            metadata?.current_version?.id ??
            attachment?.document.current_version?.id
          }
        />
      );
    }
    const attachedName = block.segment.filename ?? block.segment.content;
    return (
      <MessageFileAttachment
        {...documentFile(block.segment.document_id, attachedName)}
        key={block.segment.document_version_id}
        mediaType={
          block.segment.media_type ??
          attachmentByDocument.get(block.segment.document_id)?.mediaType
        }
        onOpen={() => onOpenMessageFile(block.segment)}
        onOpenImage={() =>
          onOpenArtifact({
            id: block.segment.document_id,
            title: attachedName,
            current_version: { id: block.segment.document_version_id },
          })
        }
        sourceFilename={attachedName}
        versionId={block.segment.document_version_id}
      />
    );
  };
  const renderAttachment = (attachment: TeamHubPresentedAttachment) => (
    <MessageFileAttachment
      {...documentFile(attachment.document.id, attachment.filename)}
      key={attachment.id}
      mediaType={attachment.mediaType}
      onOpen={() => onOpenArtifact(attachment.document)}
      sourceFilename={attachment.filename}
      versionId={
        documentMetadata[attachment.document.id]?.current_version?.id ??
        attachment.document.current_version?.id
      }
    />
  );
  const renderOutsideRun = (
    run: Exclude<(typeof bodyRuns)[number], { kind: "bubble" }>,
  ) =>
    run.kind === "block"
      ? renderBlock(run.block)
      : renderAttachment(run.attachment);
  const isFileRun = (run: (typeof bodyRuns)[number]) =>
    run.kind === "attachment" ||
    (run.kind === "block" &&
      (run.block.kind === "file" || run.block.kind === "document_card"));
  // A delivery card lists every file and folder; a Profile delivery keeps
  // its folders and fragments with its text, so it lists only files.
  const cardFileRuns = bodyRuns.filter(
    (run): run is Exclude<(typeof bodyRuns)[number], { kind: "bubble" }> =>
      run.kind !== "bubble" && (!profileDelivery || isFileRun(run)),
  );
  // A Profile delivery's text, folders, and fragments read inside its card.
  const profileBlocks = bodyBlocks.filter(
    (block) => block.kind !== "document_card" && block.kind !== "file",
  );
  const renderProfileBlock = (block: (typeof bodyBlocks)[number]) =>
    block.kind === "text" ? renderText(block) : renderBlock(block);

  return (
    <article
      ref={rowRef}
      className={`room-message-card message-row group ${card ? "has-typed-card" : ""} ${wideCard ? "has-wide-card" : ""} ${focused ? "message-row-focused" : ""}`}
      data-entering={
        (entering && !isOwn) || ownEntranceElapsed !== undefined || undefined
      }
      style={
        ownEntranceElapsed === undefined
          ? undefined
          : { animationDelay: `-${ownEntranceElapsed}ms` }
      }
      data-author-kind={message.author.kind}
      data-current-actor={isOwn}
      data-group-start={showAuthor}
      data-focused-message={focused || undefined}
      data-message-author={authorName}
      data-message-id={message.id}
      data-message-kind={message.message_kind}
      data-selected-context={selectedAsContext}
    >
      <div className="room-message-avatar">
        {showAuthor ? (
          <MessageAuthorAvatar
            cheer={cheer}
            message={message}
            name={authorName}
            onOpenProfile={onOpenProfile}
          />
        ) : null}
      </div>
      <div className="room-message-content min-w-0 flex-1">
        {!isOwn && showAuthor ? (
          <div className="room-message-header flex min-w-0 items-center gap-2">
            {!isOwn && showAuthor ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                <button
                  className="room-message-author actor-profile-inline-trigger inline-flex max-w-full items-center truncate rounded text-sm leading-5 text-app-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
                  onClick={() => onMentionAuthor?.(message.author)}
                  disabled={!onMentionAuthor || !canMentionAuthor}
                  title={
                    canMentionAuthor
                      ? `Mention ${authorName}`
                      : isAuthorMember
                        ? `${authorName} is unavailable right now`
                        : `${authorName} is no longer in this Room`
                  }
                  type="button"
                >
                  {canMentionAuthor ? (
                    <Icon
                      icon={AtIcon}
                      className="room-message-mention-icon shrink-0"
                      size={14}
                    />
                  ) : null}
                  <span className="truncate">{authorName}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {isAgent && message.routine_name ? (
          <div
            aria-label={`Scheduled task: ${message.routine_name}`}
            className="mt-2 flex min-w-0 items-center gap-1 text-xs font-normal leading-[18px] text-app-muted"
            data-testid="message-routine-label"
          >
            <Icon icon={AlarmClockIcon} className="shrink-0" size={14} />
            <span aria-hidden="true">:</span>
            <span className="truncate">{message.routine_name}</span>
          </div>
        ) : null}
        {message.context_messages?.length ? (
          <ReplyContext
            label="Reply context"
            messages={message.context_messages.map((contextMessage) => ({
              author: contextMessage.author,
              key: contextMessage.message_id,
              rawMessage: contextMessage.raw_message,
            }))}
            own={isOwn}
          />
        ) : null}
        <div className="room-message-body-line flex min-w-0 items-end">
          <div className={cn("room-message-body-main min-w-0")}>
            {message.card_title ? (
              <MessageCard
                files={
                  cardFileRuns.length
                    ? cardFileRuns.map(renderOutsideRun)
                    : undefined
                }
                profile={
                  profileDelivery && {
                    ...profileDelivery,
                    subtitle: profileParts?.[1],
                  }
                }
                profileChildren={
                  profileParts
                    ? profileBlocks.map((block, index) =>
                        index === 0 && block.kind === "text"
                          ? renderText({ ...block, body: profileParts[2]! })
                          : renderProfileBlock(block),
                      )
                    : undefined
                }
                title={message.card_title}
              >
                {profileDelivery ? profileBlocks.map(renderProfileBlock) : null}
              </MessageCard>
            ) : (
              bodyRuns.map((run, index) => {
                const spaced = index > 0 && "mt-1.5";
                if (run.kind !== "bubble") {
                  return (
                    <div
                      className={cn(
                        "flex min-w-0",
                        spaced,
                        // Own files line up with the bubble and avatar.
                        isOwn && "justify-end",
                      )}
                      key={`run:${index}`}
                    >
                      {renderOutsideRun(run)}
                    </div>
                  );
                }
                if (!bubbled) {
                  return (
                    <div className={cn("min-w-0", spaced)} key={`run:${index}`}>
                      {run.blocks.map(renderText)}
                    </div>
                  );
                }
                const first = index === firstBubbleIndex;
                return (
                  <Fragment key={`run:${index}`}>
                    <div
                      className={cn("room-message-bubble min-w-0", spaced)}
                      data-has-reactions={
                        first && reactionsUnderBubble ? "true" : undefined
                      }
                    >
                      {run.blocks.map(renderText)}
                      {index === firstBubbleIndex ? messageActions : null}
                    </div>
                    {first ? reactionBar : null}
                  </Fragment>
                );
              })
            )}

            {card ? (
              <RoomMessageCard
                actorDisplayNames={actorDisplayNames}
                card={card}
                currentActorId={currentActorId}
                messageId={message.id}
                onDecision={onCardDecision}
                roomId={message.room_id}
                roomMemberDecisionAllowed={
                  message.author.kind === "agent" &&
                  workspaceAgentIds.has(message.author.id)
                }
                tenantId={tenantId}
              />
            ) : null}
          </div>
          {bubbled ? null : messageActions}
        </div>
        {onOpenThread && message.thread && message.thread.reply_count > 0 ? (
          <ThreadReplyPreview
            message={message}
            onOpen={() => onOpenThread(message)}
          />
        ) : null}

        {reactionsOnBubble ? null : reactionBar}
      </div>
    </article>
  );
}

function MessageAuthorAvatar({
  cheer,
  message,
  name,
  onOpenProfile,
}: {
  cheer: ReactionCheer;
  message: TeamHubMessage;
  name: string;
  onOpenProfile: (actorId: string) => void;
}) {
  return (
    <div className="relative size-(--chat-avatar-size) shrink-0">
      {message.author.kind === "agent" ? (
        <>
          <AgentStatusAvatar
            actorId={message.author.id}
            cheer={cheer.count}
            name={name}
            onOpenProfile={onOpenProfile}
          />
          <ReactionCheerBurst cheer={cheer} />
        </>
      ) : (
        <ActorAvatar
          actorId={message.author.id}
          kind="human"
          name={name}
          size="sm"
        />
      )}
    </div>
  );
}

function ConversationMessageActions({
  currentActorId,
  hasCardPayload,
  message,
  onOpenThread,
  onForwardMessage,
  onReply,
  onToggleReaction,
}: Pick<
  MessageRowProps,
  "message" | "currentActorId" | "onOpenThread" | "onForwardMessage" | "onReply"
> & {
  hasCardPayload: boolean;
  onToggleReaction?: (reactionId: TeamHubMessageReactionId) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const overflowItems: ActionMenuItem[] = [];

  if (onForwardMessage) {
    overflowItems.push({
      icon: <Icon icon={SentIcon} size={14} />,
      label: "Forward message",
      onSelect: () => onForwardMessage(message),
    });
  }
  if (onReply) {
    overflowItems.push({
      icon: <Icon icon={MailReply01Icon} size={14} />,
      label: "Reply to message",
      onSelect: () => onReply(message),
    });
  }
  if (onOpenThread && !hasCardPayload) {
    overflowItems.push({
      icon: <Icon icon={Message01Icon} size={14} />,
      label: "Reply to thread",
      onSelect: () => {
        // The sidebar must restore focus to the persistent trigger, not the removed menu item.
        actionsRef.current
          ?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
          ?.focus({ preventScroll: true });
        onOpenThread(message, { focusComposer: true });
      },
    });
  }

  return (
    <div
      ref={actionsRef}
      className="message-row-actions message-row-actions-beside z-10 flex shrink-0 items-center gap-0.5"
      data-reaction-picker-open={reactionPickerOpen || undefined}
    >
      {onToggleReaction ? (
        <MessageActionButton
          aria-label="Add reaction"
          aria-pressed={reactionPickerOpen}
          onClick={() => setReactionPickerOpen((open) => !open)}
          tooltip="Add reaction"
        >
          <Icon icon={SmilePlusIcon} size={16} />
        </MessageActionButton>
      ) : null}
      {onToggleReaction && reactionPickerOpen && actionsRef.current ? (
        <MessageReactionPicker
          anchor={actionsRef.current}
          isSelected={(reactionId) =>
            hasOwnReaction(message, reactionId, currentActorId)
          }
          onClose={() => setReactionPickerOpen(false)}
          reacted={
            new Set(
              (message.reactions ?? []).map((reaction) => reaction.reaction_id),
            )
          }
          onSelect={onToggleReaction}
        />
      ) : null}
      <MessageActionButton
        aria-label="Copy message"
        onClick={() => {
          void import("@/lib/clipboard")
            .then(({ writeClipboardText }) =>
              writeClipboardText(message.raw_message),
            )
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => setCopied(false));
        }}
        tooltip={copied ? "Copied" : "Copy message"}
      >
        {copied ? (
          <Icon icon={Tick02Icon} size={16} />
        ) : (
          <Icon icon={Copy01Icon} size={16} />
        )}
      </MessageActionButton>
      {overflowItems.length ? (
        <ActionMenu
          buttonClassName="message-inline-action-button flex items-center justify-center rounded-lg p-0.5 text-muted-foreground hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-app-focus"
          iconClassName="flex size-3.5 shrink-0 items-center justify-center"
          itemClassName="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-(family-name:--app-room-font) text-sm text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          items={overflowItems}
          label="More message actions"
          menuClassName="fixed z-[100] w-48 rounded-md bg-popover p-1 font-(family-name:--app-room-font) text-sm shadow-md"
          trigger={<Icon icon={MoreHorizontalIcon} size={16} />}
        />
      ) : null}
    </div>
  );
}

function MessageActionButton({
  "aria-label": ariaLabel,
  "aria-pressed": ariaPressed,
  children,
  disabled = false,
  onClick,
  tooltip,
}: {
  "aria-label": string;
  "aria-pressed"?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <span className="message-action-tooltip-trigger relative inline-flex items-center leading-none">
      <Button
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
        className="message-inline-action-button !border-0 rounded-lg p-0.5 text-muted-foreground shadow-none hover:text-accent-foreground [&_svg]:!size-4 [&_svg]:shrink-0"
        disabled={disabled}
        onClick={onClick}
        size="compactIcon"
        tone="ghost"
      >
        {children}
      </Button>
      <span className="message-action-tooltip" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}

export function PendingMessageRow({
  actorId,
  actorName,
  startsGroup,
  message,
  onCancel,
  onOpenProfile,
  onOpenUrl,
  onRetry,
}: {
  actorId?: string;
  actorName: string;
  startsGroup: boolean;
  message: PendingRoomMessage;
  onCancel: (clientId: string) => Promise<void> | void;
  onOpenProfile: (actorId: string) => void;
  onOpenUrl?: (url: string) => void;
  onRetry: (clientId: string) => void;
}) {
  // A send that commits quickly never shows a status line, so the committed
  // row replaces it at the same height.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (message.status !== "sending") return;
    const timer = setTimeout(() => setSlow(true), SENDING_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [message.status]);
  return (
    <article
      className="room-message-card"
      data-author-kind="human"
      data-current-actor="true"
      data-entering="true"
      data-group-start={startsGroup}
    >
      <div className="room-message-avatar">
        {startsGroup ? (
          <ActorAvatar
            actorId={actorId}
            kind="human"
            name={actorName}
            size="sm"
          />
        ) : null}
      </div>
      <div className="room-message-content min-w-0">
        {message.contextMessages.length ? (
          <ReplyContext
            label="Pending reply context"
            messages={message.contextMessages.map((contextMessage) => ({
              author: contextMessage.author,
              key: contextMessage.id,
              rawMessage: contextMessage.raw_message,
            }))}
            own
          />
        ) : null}
        {message.body ? (
          <div className="room-message-bubble ml-auto w-fit text-app-ink">
            <MessageMarkdown
              authorKind="human"
              body={message.body}
              mentions={message.mentions}
              onOpenActor={onOpenProfile}
              onOpenUrl={onOpenUrl}
            />
          </div>
        ) : null}
        {message.attachments.map((attachment, index) => (
          // Spaced like the committed row, whose first block has no margin.
          <div
            className={cn(
              "flex justify-end",
              (index > 0 || message.body) && "mt-1.5",
            )}
            key={attachment.clientId}
          >
            {selectArtifactRenderer({
              filename: attachment.file.name,
              mediaType: attachment.file.type,
              sizeBytes: attachment.file.size,
            }).kind === "image" ? (
              <PendingImage file={attachment.file} />
            ) : (
              <MessageFileItem
                detail={fileItemDetail(
                  artifactFileTypeLabel(attachment.filename),
                  attachment.sizeBytes,
                )}
                name={attachment.filename}
                visual={<FileTypeIcon filename={attachment.filename} />}
              />
            )}
          </div>
        ))}
        {message.status !== "sending" || slow ? (
          <div className="mt-1 flex items-center justify-end gap-2 leading-[18px]">
            <span className="text-xs text-muted-foreground">
              {message.status === "sending"
                ? "Sending..."
                : message.status === "unknown"
                  ? "Delivery status unknown"
                  : "Not sent"}
            </span>
          </div>
        ) : null}
        {message.status === "failed" || message.status === "unknown" ? (
          <div className="mt-2 flex flex-col items-end gap-2">
            <span className="text-right text-sm text-destructive" role="alert">
              {message.error ?? "Failed to connect to the server..."}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => onRetry(message.clientId)}
                type="button"
              >
                <Icon
                  icon={RotateLeft01Icon}
                  className="size-4 text-muted-foreground"
                  size={16}
                />
                <span className="px-1">Retry</span>
              </button>
              <button
                className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => void onCancel(message.clientId)}
                type="button"
              >
                <Icon
                  icon={Cancel01Icon}
                  className="size-4 text-muted-foreground"
                  size={16}
                />
                <span className="px-1">Cancel</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** A sending image shows from the local file at the size it will have once sent. */
function PendingImage({ file }: { file: File }) {
  const image = useDecodedImage(file);
  if (!image) return null;
  return (
    <img
      alt={file.name}
      {...chatImageSize(image)}
      className="block h-auto max-h-[360px] w-fit max-w-[min(28rem,100%)] rounded-xl object-contain"
      decoding="async"
      src={image.url}
    />
  );
}
