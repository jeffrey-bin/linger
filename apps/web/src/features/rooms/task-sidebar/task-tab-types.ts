export const TASK_TAB_CAP = 6;
export const TASK_CLOSED_STACK_CAP = 5;

export interface TaskTabScope {
  accountId: string;
  tenantId: string;
  roomId: string;
}

export type TaskAnchorResolution = "error" | "loading" | "unavailable";

export interface TaskViewSnapshot {
  anchorMessageId: string;
  scrollAnchorMessageId?: string;
  scrollAnchorOffset: number;
  checkpointsOpen: boolean;
  filesOpen: boolean;
  lastActivatedAt: number;
}

export interface TaskTabState {
  openTabIds: string[];
  activeTabId: string | null;
  snapshots: Record<string, TaskViewSnapshot>;
  closedStack: TaskViewSnapshot[];
  lastEvicted: TaskViewSnapshot | null;
}
