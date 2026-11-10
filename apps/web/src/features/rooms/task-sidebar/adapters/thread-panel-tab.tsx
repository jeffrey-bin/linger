import { useState } from "react";

import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { ThreadPanel } from "../../chat/thread-panel";

export function ThreadPanelTab({
  accountId,
  activityRoomId,
  anchorMessage,
  hidden = false,
  mentionOptions,
  onOpenProfile,
  rootMentions,
  tenantId,
}: {
  accountId: string;
  activityRoomId?: string;
  anchorMessage: TeamHubMessage;
  hidden?: boolean;
  mentionOptions: TeamHubActorRef[];
  onOpenProfile?: (actorId: string) => void;
  rootMentions?: TeamHubActorRef[];
  tenantId: string;
}) {
  const [threadRoomId, setThreadRoomId] = useState(
    anchorMessage.thread?.room_id,
  );
  // Activity observes this conversation's Run Status Query, including while its tab
  // is hidden. Keep only that source mounted so its existing SSE stays alive.
  const keepMounted = Boolean(
    activityRoomId && activityRoomId === threadRoomId,
  );
  return (
    <div
      className={
        hidden
          ? "hidden"
          : "flex h-full min-h-0 flex-col overflow-hidden app-work-surface"
      }
      data-testid={`panel-tab-thread-${anchorMessage.id}`}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {hidden && !keepMounted ? null : (
        <ThreadPanel
          accountId={accountId}
          mentionOptions={mentionOptions}
          onOpenProfile={onOpenProfile}
          onRoomResolved={setThreadRoomId}
          rootMentions={rootMentions}
          rootMessage={anchorMessage}
          tenantId={tenantId}
        />
      )}
    </div>
  );
}
