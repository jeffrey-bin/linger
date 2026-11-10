import type { TeamHubWorkItem } from "@/features/teamhub/teamhub-types";

export const NO_SOURCE_ROOM_FILTER = "!no-source";

export function createWorkItemRoomFilterModel(
  visibleRooms: Array<{ id: string; name: string }>,
  items: TeamHubWorkItem[],
) {
  const roomNames = new Map(visibleRooms.map((room) => [room.id, room.name]));
  const originRoomIds = [
    ...new Set(
      items.flatMap((item) =>
        item.origin_room_id ? [item.origin_room_id] : [],
      ),
    ),
  ];
  const knownOptions: Array<{ id: string; label: string }> = [];
  const unknownOptions: Array<{ id: string; label: string }> = [];
  for (const roomId of originRoomIds) {
    const name = roomNames.get(roomId);
    (name ? knownOptions : unknownOptions).push({
      id: roomId,
      label: name ? `#${name}` : unknownRoomLabel(roomId),
    });
  }
  knownOptions.sort(compareFilterOptions);
  unknownOptions.sort(compareFilterOptions);

  return {
    matches(item: TeamHubWorkItem, filter: string) {
      if (!filter) return true;
      if (filter === NO_SOURCE_ROOM_FILTER) return !item.origin_room_id;
      return item.origin_room_id === filter;
    },
    options: [
      ...knownOptions,
      ...unknownOptions,
      ...(items.some((item) => !item.origin_room_id)
        ? [{ id: NO_SOURCE_ROOM_FILTER, label: "No source room" }]
        : []),
    ],
    originLabel(item: TeamHubWorkItem) {
      if (!item.origin_room_id) return "No source room";
      const name = roomNames.get(item.origin_room_id);
      return name ? `#${name}` : unknownRoomLabel(item.origin_room_id);
    },
  };
}

function compareFilterOptions(
  left: { id: string; label: string },
  right: { id: string; label: string },
) {
  return (
    left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  );
}

function unknownRoomLabel(roomId: string) {
  return `Unknown room (${roomId})`;
}
