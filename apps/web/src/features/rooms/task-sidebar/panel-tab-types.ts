export const PANEL_TAB_CAP = 6;
export const PANEL_CLOSED_STACK_CAP = 5;

export interface PanelTabScope {
  accountId: string;
  tenantId: string;
  roomId: string;
}

export type PanelTabKind =
  | "agentInfo"
  | "agentActivity"
  | "thread"
  | "file"
  | "taskActivity"
  | "roomSettings"
  | "roomInfo"
  | "collaboration"
  | "url";

export interface PanelTab {
  id: string;
  kind: PanelTabKind;
  activityRunStatusId?: string;
  activityRunId?: string;
  activityRoomId?: string;
  taskId?: string;
  anchorMessageId?: string;
  actorId?: string;
  documentId?: string;
  versionId?: string;
  previewCurrentVersion?: boolean;
  title: string;
  previewUrl?: string;
  lastActivatedAt: number;
}

export interface PanelTabState {
  defaultAgentInfoDismissed?: boolean;
  openTabIds: string[];
  activeTabId: string | null;
  tabs: Record<string, PanelTab>;
  closedStack: PanelTab[];
  lastEvicted: PanelTab | null;
}

export const PANEL_COLLECTION_TAB_IDS = {
  file: "file:library",
  thread: "thread:draft",
  roomSettings: "roomSettings:current",
  roomInfo: "roomInfo:current",
  collaboration: "collaboration:current",
  url: "url:preview",
} as const;

export const PANEL_COLLECTION_TAB_TITLES = {
  file: "Files",
  thread: "Anotherme",
  roomSettings: "Room settings",
  roomInfo: "Room info",
  collaboration: "Collaboration",
  url: "Lovable vs Enter Pro | AI Website Builder",
} as const;

export function panelTabKey(
  kind: PanelTabKind,
  ref: {
    taskId?: string;
    actorId?: string;
    anchorMessageId?: string;
    documentId?: string;
  },
): string {
  if (kind === "taskActivity") {
    if (!ref.taskId)
      throw new Error("panelTabKey: taskActivity requires taskId");
    return `taskActivity:${ref.taskId}`;
  }
  if (kind === "agentInfo" || kind === "agentActivity") {
    if (!ref.actorId) throw new Error(`panelTabKey: ${kind} requires actorId`);
    return `${kind}:${ref.actorId}`;
  }
  if (kind === "file") {
    return ref.documentId
      ? `file:${ref.documentId}`
      : PANEL_COLLECTION_TAB_IDS.file;
  }
  if (!ref.anchorMessageId) {
    if (kind === "thread") return PANEL_COLLECTION_TAB_IDS.thread;
    if (kind === "roomSettings") return PANEL_COLLECTION_TAB_IDS.roomSettings;
    if (kind === "roomInfo") return PANEL_COLLECTION_TAB_IDS.roomInfo;
    if (kind === "collaboration") return PANEL_COLLECTION_TAB_IDS.collaboration;
    if (kind === "url") return PANEL_COLLECTION_TAB_IDS.url;
    throw new Error(`panelTabKey: ${String(kind)} requires anchorMessageId`);
  }
  return `${kind}:${ref.anchorMessageId}`;
}

export function isPanelCollectionTab(tab: PanelTab): boolean {
  if (tab.kind === "file") return !tab.documentId;
  if (
    tab.kind === "thread" ||
    tab.kind === "roomSettings" ||
    tab.kind === "roomInfo" ||
    tab.kind === "collaboration" ||
    tab.kind === "url"
  ) {
    return !tab.anchorMessageId;
  }
  return false;
}
