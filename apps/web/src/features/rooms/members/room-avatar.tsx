import { Message01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "./actor-avatar";

/**
 * Where each face sits, by how many faces the stack shows. The first member
 * leads in the larger top-left tile; the rest are small tiles around it.
 */
const ROOM_AVATAR_LAYOUTS: Record<number, readonly string[]> = {
  1: ["solo"],
  2: ["lead", "br"],
  3: ["lead-center", "bl", "br"],
  4: ["lead", "tr", "bl", "br"],
};

/**
 * The "Room avatar stack": the first member leads in a larger tile and the next
 * ones stack around it, up to four faces. From five members on, the
 * bottom-right tile counts the members not shown.
 */
export function RoomAvatar({
  members,
  size = "nav",
}: {
  /** Only identity and display fields are drawn, so stored snapshots qualify. */
  members: Array<Pick<TeamHubActorRef, "display_name" | "id" | "kind">>;
  size?: "header" | "lg" | "nav";
}) {
  if (members.length === 0) {
    return (
      <span
        aria-hidden="true"
        className="room-avatar room-avatar-empty"
        data-size={size}
      >
        <Icon icon={Message01Icon} size={size === "lg" ? 24 : 16} />
      </span>
    );
  }
  const overflow = members.length > 4 ? members.length - 3 : 0;
  const faces = members.slice(0, overflow ? 3 : 4);
  const positions = ROOM_AVATAR_LAYOUTS[overflow ? 4 : faces.length]!;
  return (
    <span aria-hidden="true" className="room-avatar" data-size={size}>
      {faces.map((member, index) => (
        <span
          className="room-avatar-tile"
          data-position={positions[index]}
          key={member.id}
        >
          <ActorAvatar
            actorId={member.id}
            kind={member.kind}
            name={member.display_name}
            size="micro"
          />
        </span>
      ))}
      {overflow ? (
        <span className="room-avatar-more" data-position="br">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
