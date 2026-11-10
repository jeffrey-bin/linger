import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { ActorAvatar } from "./actor-avatar";

export function RoomMemberAvatars({ actors }: { actors: TeamHubActorRef[] }) {
  return (
    <>
      <span className="relative z-[1] flex items-center">
        {actors.slice(0, 5).map((actor, index) => (
          <span
            className={`room-member-avatar flex size-[18px] items-center justify-center bg-app-surface p-px ${
              actor.kind === "agent" ? "rounded-md" : "rounded-full"
            } ${index === 0 ? "" : "-ml-2"}`}
            data-actor-kind={actor.kind}
            key={actor.id}
          >
            <ActorAvatar
              actorId={actor.id}
              kind={actor.kind}
              name={actor.display_name}
              size="micro"
            />
          </span>
        ))}
      </span>
      <span className="relative z-[1] flex h-[18px] min-w-[22px] items-center justify-center px-1 text-2xs font-medium leading-[18px] text-muted-foreground">
        {actors.length}
      </span>
    </>
  );
}
