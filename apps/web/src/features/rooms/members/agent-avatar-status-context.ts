import { createContext } from "react";
import type { AgentLiveActivity } from "./agent-live-activities";

export interface AgentAvatarStatus {
  status: string;
  activities: readonly AgentLiveActivity[];
}
export const AgentAvatarStatusContext = createContext<{
  onOpenProfile: (actorId: string) => void;
  onOpenActivityLog?: (actorId: string) => void;
  statuses: ReadonlyMap<string, AgentAvatarStatus>;
}>({
  onOpenProfile: () => undefined,
  statuses: new Map(),
});
