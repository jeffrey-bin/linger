import { RoomTaskSidebarImpl } from "./room-task-sidebar-impl";

type Props = Parameters<typeof RoomTaskSidebarImpl>[0];

/** Thin entry so react-doctor size limits apply to the implementation module. */
export function RoomTaskSidebar(props: Props) {
  return <RoomTaskSidebarImpl {...props} />;
}
