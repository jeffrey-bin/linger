import { Fragment, type PropsWithChildren, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import {
  formatMessageTime,
  isRoomNotice,
  messageStartsConversation,
} from "./message-grouping";
import type { useRoomTimelineScroll } from "./use-room-timeline-scroll";

/** The Thread's root Message, then its replies in conversation groups, with
 * pending replies passed as children. */
export function ThreadTimeline({
  canLoadEarlier,
  children,
  hasPending,
  loadingEarlier,
  onLoadEarlier,
  opening,
  renderMessage,
  replies,
  rootMessage,
  timeline,
}: PropsWithChildren<{
  canLoadEarlier: boolean;
  hasPending: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  opening: boolean;
  renderMessage: (
    message: TeamHubMessage,
    showAuthor: boolean,
    reply: boolean,
  ) => ReactNode;
  replies: TeamHubMessage[];
  rootMessage: TeamHubMessage;
  timeline: ReturnType<typeof useRoomTimelineScroll>;
}>) {
  return (
    <div
      aria-busy={opening || undefined}
      aria-label="Thread timeline"
      data-voice-scroll="thread"
      className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-10 [overflow-anchor:none]"
      data-initial-scroll-ready={timeline.initialScrollReady}
      data-thread-loading={opening || undefined}
      onScroll={(event) => timeline.recordTimelineScroll(event.currentTarget)}
      ref={timeline.timelineRef}
    >
      <ConversationTime at={rootMessage.created_at} />
      {renderMessage(rootMessage, true, false)}
      {opening ? (
        <div className="mt-4 space-y-3" data-testid="thread-panel-loading">
          <p className="text-[12px] font-medium text-app-muted">
            Opening Thread…
          </p>
          <div className="h-16 animate-pulse rounded-lg bg-app-hover" />
          <div className="h-16 animate-pulse rounded-lg bg-app-hover" />
        </div>
      ) : null}
      {replies.length || hasPending ? (
        <div className="my-4 flex items-center gap-2 text-[12px] text-app-subtle">
          <span className="h-px flex-1 bg-app-border" />
          Replies
          <span className="h-px flex-1 bg-app-border" />
        </div>
      ) : null}
      {canLoadEarlier ? (
        <div className="mb-3 text-center">
          <Button loading={loadingEarlier} onClick={onLoadEarlier}>
            Load earlier replies
          </Button>
        </div>
      ) : null}
      <div className="space-y-1">
        {replies.map((message, index) => {
          const previous = replies[index - 1];
          const startsConversation = messageStartsConversation(
            message,
            previous,
          );
          return (
            <Fragment key={message.id}>
              {startsConversation ? (
                <ConversationTime at={message.created_at} />
              ) : null}
              {renderMessage(
                message,
                startsConversation ||
                  previous?.author.id !== message.author.id ||
                  isRoomNotice(previous),
                true,
              )}
            </Fragment>
          );
        })}
        {children}
      </div>
    </div>
  );
}

function ConversationTime({ at }: { at: string }) {
  return (
    <div className="room-conversation-time text-center text-xs text-app-subtle">
      <time dateTime={at}>{formatMessageTime(at)}</time>
    </div>
  );
}
