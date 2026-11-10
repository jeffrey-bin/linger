import { useCallback, useMemo, useSyncExternalStore } from "react";

import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import type { TeamHubRoomMember } from "@/features/teamhub/teamhub-types";

import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import {
  type CurrentPresenceActor,
  listRoomDocumentParticipants,
  presenceIdentitySnapshot,
} from "./room-document-presence-model";

export function RoomDocumentPresence({
  awareness,
  currentActor,
  members,
  showSelf = false,
}: {
  awareness: RoomDocumentCollaborationSession["awareness"];
  currentActor: CurrentPresenceActor;
  members: readonly TeamHubRoomMember[] | undefined;
  showSelf?: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (awareness === null) return () => undefined;
      let active = true;
      let scheduled = false;
      const notify = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (active) listener();
        });
      };
      awareness.on("change", notify);
      return () => {
        active = false;
        awareness.off("change", notify);
      };
    },
    [awareness],
  );
  const getSnapshot = useCallback(
    () => presenceIdentitySnapshot(awareness),
    [awareness],
  );
  const identitySnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const projectedParticipants = useMemo(
    () => listRoomDocumentParticipants({ awareness, currentActor, members }),
    // The awareness map mutates in place; identitySnapshot signals its changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identitySnapshot is an intentional invalidation key
    [awareness, currentActor, identitySnapshot, members],
  );
  const participants =
    showSelf && projectedParticipants.length === 0
      ? [
          {
            actorId: currentActor.id,
            clientId: 0,
            color: currentActor.color,
            initials: currentActor.displayName
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase())
              .join(""),
            isCurrent: true,
            name: currentActor.displayName,
          },
        ]
      : projectedParticipants;

  if (participants.length < 2 && !showSelf) return null;

  const visibleParticipants = participants.slice(0, 5);
  const names = participants.map((participant) => participant.name).join(", ");
  const membersByActorId = new Map(
    members?.map((member) => [member.actor.id, member.actor]),
  );

  return (
    <span
      aria-label={`${participants.length} people in this document: ${names}`}
      aria-live="polite"
      className="inline-flex min-w-0 shrink-0 items-center"
      role="status"
    >
      <span className="sr-only">{participants.length} people viewing</span>
      <span className="flex -space-x-[5px] rounded-full p-1">
        {visibleParticipants.map((participant) => (
          <span
            className="relative rounded-full border bg-app-surface p-px"
            key={participant.actorId}
            style={{ borderColor: participant.color }}
            title={`${participant.name}${participant.isCurrent ? " (you)" : ""}`}
          >
            <ActorAvatar
              actorId={participant.actorId}
              kind={membersByActorId.get(participant.actorId)?.kind ?? "human"}
              name={participant.name}
              size="micro"
            />
          </span>
        ))}
        {participants.length > visibleParticipants.length ? (
          <span className="relative grid size-[18px] place-items-center rounded-full border border-app-surface bg-app-ink text-[8px] font-semibold text-app-surface">
            +{participants.length - visibleParticipants.length}
          </span>
        ) : null}
      </span>
    </span>
  );
}
