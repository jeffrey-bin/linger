import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";
import { useOutletContext } from "react-router";

import type { RoomRealtimeStatus } from "@/features/teamhub/event-transport";
import type { TeamHubMessagePresentation } from "@/features/teamhub/teamhub-runtime";

import type { PanelTabKind } from "./task-sidebar/panel-tab-types";

export interface OpenPanelTabInput {
  kind: PanelTabKind;
  activityRunStatusId?: string;
  activityRunId?: string;
  activityRoomId?: string;
  taskId?: string;
  actorId?: string;
  anchorMessageId?: string;
  documentId?: string;
  preserveAgentInfoActivity?: boolean;
  previewUrl?: string;
  title?: string;
  versionId?: string;
  previewCurrentVersion?: boolean;
}

export interface RoomOutletContext {
  prefetchPanel?: () => void;
  focusPanelMessageId: string | null;
  lastAppliedRoomSeq: number;
  messagePresentations: Readonly<Record<string, TeamHubMessagePresentation>>;
  openProfile: (actorId: string) => void;
  openPanelTab: (input: OpenPanelTabInput) => void;
  recordMessagePresentation: (
    messageId: string,
    presentation: TeamHubMessagePresentation,
  ) => void;
  status: RoomRealtimeStatus;
}

export const noopOpenPanelTab: RoomOutletContext["openPanelTab"] = () =>
  undefined;

const standaloneRoomOutletContext: RoomOutletContext = {
  focusPanelMessageId: null,
  lastAppliedRoomSeq: 0,
  messagePresentations: {},
  openProfile: () => undefined,
  openPanelTab: noopOpenPanelTab,
  recordMessagePresentation: () => undefined,
  status: "connected",
};

const RoomChromeContext = createContext<RoomOutletContext | undefined>(
  undefined,
);

export function RoomChromeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: RoomOutletContext;
}) {
  return createElement(RoomChromeContext, { value }, children);
}

export function useRoomOutletContext() {
  const chrome = useContext(RoomChromeContext);
  const outlet = useOutletContext<RoomOutletContext | undefined>();
  return chrome ?? outlet ?? standaloneRoomOutletContext;
}
