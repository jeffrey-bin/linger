import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

export interface PanelTask {
  anchorMessage: TeamHubMessage;
  rootMentions?: TeamHubActorRef[];
}

/** @deprecated Use PanelTask */
export type TaskViewTask = PanelTask;
