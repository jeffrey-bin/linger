import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useInfiniteQuery } from "@tanstack/react-query";

import { ActorAvatar } from "../../members/actor-avatar";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { roomMessagesInfiniteQueryOptions } from "../../room-queries";
import { RuntimeActivityPath } from "../../runtime-status/runtime-activity-path-view";
import { useRuntimePresentationEventRecords } from "../../runtime-status/use-runtime-presentation-event-records";
import { PanelLoading } from "../panel-loading";

const EMPTY_MESSAGES: readonly TeamHubMessage[] = [];

export function AgentLiveActivityPanelTab({
  activationKey,
  actorId,
  actorName,
  runStatusId,
  runId,
  hidden,
  messages = EMPTY_MESSAGES,
  messagesRoomId,
  onBack,
  backLabel = "Back to Agent info",
  roomId,
  tenantId,
}: {
  activationKey?: number;
  actorId: string;
  actorName: string;
  runStatusId?: string;
  runId?: string;
  hidden: boolean;
  messages?: readonly TeamHubMessage[];
  messagesRoomId: string;
  onBack?: () => void;
  backLabel?: string;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  // The sidebar supplies its parent Room's messages. A Thread Activity shares
  // the Thread conversation's existing query instead of reading that parent.
  const targetMessages = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
    enabled: !hidden && roomId !== messagesRoomId,
  });
  const activityMessages =
    roomId === messagesRoomId
      ? messages
      : (targetMessages.data?.pages.flatMap((page) => page.items) ??
        EMPTY_MESSAGES);
  const events = useRuntimePresentationEventRecords({
    runStatusId: runStatusId ?? "",
    runId,
    actorId,
    enabled: !hidden,
    roomId,
    tenantId,
  });
  const hasEvents = events.items.length > 0;
  const pending = events.pending;

  return (
    <div
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      data-testid="agent-live-activity-panel"
      data-run-id={runId}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-border bg-card px-4 py-2">
        {onBack ? (
          <button
            aria-label={backLabel}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
            onClick={onBack}
            title={backLabel}
            type="button"
          >
            <Icon icon={ArrowLeft01Icon} size={16} />
          </button>
        ) : null}
        <ActorAvatar
          actorId={actorId}
          kind="agent"
          name={actorName}
          size="xs"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {`${actorName} activity`}
          </h2>
          <p className="truncate text-xs font-normal leading-4 text-app-muted">
            {pending || hasEvents ? "Activity" : "Waiting for activity"}
          </p>
        </div>
      </header>
      {events.error ? (
        <LiveActivityState
          detail="Published Runtime events could not be read from TeamHub."
          title="Activity could not be loaded"
        />
      ) : pending ? (
        <PanelLoading label="Loading activity" />
      ) : hasEvents ? (
        <RuntimeActivityPath
          key={`${activationKey}:${hidden}:${runId ?? runStatusId}`}
          messages={activityMessages}
          records={events.items}
        />
      ) : (
        <LiveActivityState
          detail="This run has not published any activity events yet."
          title="No activity yet"
        />
      )}
    </div>
  );
}

function LiveActivityState({
  detail,
  title,
}: {
  detail?: string;
  title: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <h3 className="text-sm font-semibold text-app-ink">{title}</h3>
      {detail ? (
        <p className="mt-1.5 max-w-64 text-xs leading-5 text-app-muted">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
