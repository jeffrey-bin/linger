import { useContext } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { ActorAvatar } from "./actor-avatar";
import { AgentLiveActivities } from "./agent-live-activities";
import {
  AgentAvatarStatusContext,
  type AgentAvatarStatus,
} from "./agent-avatar-status-context";

export function AgentStatusAvatar({
  actorId,
  cheer,
  name,
  size = "sm",
  status,
  onOpenProfile,
}: {
  actorId: string;
  /** Each new value makes the character lean in and smile once. */
  cheer?: number;
  name: string;
  size?: "xs" | "sm" | "md";
  status?: AgentAvatarStatus;
  onOpenProfile?: (actorId: string) => void;
}) {
  const context = useContext(AgentAvatarStatusContext);
  const live = status ?? context.statuses.get(actorId);
  const openProfile = onOpenProfile ?? context.onOpenProfile;
  const avatar = (
    <ActorAvatar
      actorId={actorId}
      cheer={cheer}
      kind="agent"
      name={name}
      showTitle={false}
      size={size}
    />
  );
  return (
    <ActionMenu
      followAnchor
      openOnHover
      onTriggerClick={!live ? () => openProfile(actorId) : undefined}
      placement="bottom-start"
      label={`Open ${name} ${live ? "status" : "profile"}`}
      trigger={avatar}
      buttonClassName="shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-app-focus"
      menuClassName="agent-status-popover fixed z-[100] w-72 max-w-[calc(100vw-16px)] max-h-[min(360px,calc(100dvh-16px))] overflow-y-auto rounded-xl bg-popover p-1.5 shadow-md"
      header={
        <div className="space-y-3 p-2">
          <div className="flex items-center gap-2">
            <ActorAvatar
              actorId={actorId}
              kind="agent"
              name={name}
              showTitle={false}
            />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold leading-[22px] text-app-ink">
                {name}
              </p>
              {live ? (
                <p className="text-xs leading-[18px] text-app-subtle">
                  {live.status}
                </p>
              ) : null}
            </div>
          </div>
          <AgentLiveActivities activities={live?.activities ?? []} />
        </div>
      }
      items={[
        ...(context.onOpenActivityLog
          ? [
              {
                label: "View activity",
                onSelect: () => context.onOpenActivityLog?.(actorId),
              },
            ]
          : []),
      ]}
      itemClassName="mt-1 flex min-h-8 w-full items-center rounded-2xl px-2 text-left text-xs text-app-muted hover:bg-app-hover focus:bg-app-hover outline-none"
    />
  );
}
