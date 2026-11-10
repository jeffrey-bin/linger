import { useQuery } from "@tanstack/react-query";

import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import { tenantAgentsQueryOptions } from "@/features/rooms/room-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { cn } from "@/lib/cn";

import "./wiki-working-card.css";

/** The signed-in Human's Another Me, whose avatar the working states show. */
export function useAnotherMeActorId(tenantId: string): string | undefined {
  const { client } = useTeamHubRuntime();
  const agents = useQuery(tenantAgentsQueryOptions(client, tenantId));
  return agents.data?.items.find((agent) => agent.agent_type === "anotherme")
    ?.actor.id;
}

function WorkingAvatar({
  actorId,
  size,
}: {
  actorId?: string;
  size: "lg" | "xxs";
}) {
  return (
    <span
      className={
        size === "lg" ? "wiki-working-avatar" : "wiki-working-line-avatar"
      }
    >
      <ActorAvatar
        actorId={actorId}
        kind="agent"
        name="Another Me"
        showTitle={false}
        size={size}
      />
    </span>
  );
}

/**
 * Another Me is writing a page that will appear here all at once: one line
 * centered where the page will be.
 */
export function WikiWorkingCenter({
  actorId,
  title,
}: {
  actorId?: string;
  title: string;
}) {
  return (
    <div aria-live="polite" className="wiki-working-center" role="status">
      <WorkingAvatar actorId={actorId} size="lg" />
      <span className="wiki-working-center-title">{title}</span>
    </div>
  );
}

/** One line above content that Another Me is writing or updating, in the
 * page's own type; only the avatar floats gently. */
export function WikiWorkingLine({
  actorId,
  className,
  text,
}: {
  actorId?: string;
  className?: string;
  text: string;
}) {
  return (
    <div
      aria-live="polite"
      className={cn("wiki-working-line", className)}
      role="status"
    >
      <WorkingAvatar actorId={actorId} size="xxs" />
      <span className="wiki-working-line-text">{text}</span>
    </div>
  );
}
