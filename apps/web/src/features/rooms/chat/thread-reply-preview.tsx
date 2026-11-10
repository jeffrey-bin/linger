import { useQuery } from "@tanstack/react-query";

import { BubbleChatIcon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { roomMessagesQueryKey } from "../room-queries";

export const MAX_THREAD_PREVIEW_REPLIES = 3;
const PREVIEW_BODY_CHARS = 140;

export function ThreadReplyPreview({
  message,
  onOpen,
}: {
  message: TeamHubMessage;
  onOpen: () => void;
}) {
  const thread = message.thread;
  const runtime = useOptionalTeamHubRuntime();
  const replyCount = thread?.reply_count ?? 0;
  const threadRoomId = thread?.room_id;
  const repliesQuery = useQuery({
    enabled: Boolean(runtime && threadRoomId && replyCount > 0),
    queryFn: async () => {
      if (!runtime || !threadRoomId) return [];
      const page = await teamHubData(
        runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
          params: {
            path: { roomId: threadRoomId },
            query: { limit: MAX_THREAD_PREVIEW_REPLIES + 1 },
          },
        }),
      );
      return page.items
        .filter((item) => item.message_kind !== "agent_runtime")
        .slice(-MAX_THREAD_PREVIEW_REPLIES);
    },
    queryKey: [
      ...roomMessagesQueryKey(message.tenant_id, threadRoomId ?? ""),
      "thread-preview",
      message.id,
    ],
  });
  if (!thread || replyCount <= 0) return null;

  const previews = repliesQuery.data ?? [];
  const repliesLabel = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;

  return (
    <button
      aria-label={`Open thread, ${repliesLabel}`}
      className="mt-2 inline-flex h-6 items-center justify-center rounded-full bg-muted px-1.5 font-(family-name:--app-room-font) text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-focus"
      onClick={onOpen}
      type="button"
    >
      <Icon icon={BubbleChatIcon} size={14} />
      <span className="px-1 text-xs font-medium">{repliesLabel}</span>
      {previews.length ? (
        <span className="sr-only">
          {previews.map(
            (reply) =>
              `${reply.author.display_name}: ${truncatePreviewBody(reply.raw_message)}`,
          )}
        </span>
      ) : null}
    </button>
  );
}

function truncatePreviewBody(body: string) {
  const compact = markdownPlainText(body).replace(/\s+/g, " ").trim();
  if (compact.length <= PREVIEW_BODY_CHARS) return compact;
  return `${compact.slice(0, PREVIEW_BODY_CHARS).trimEnd()}…`;
}
