import { useCallback, useLayoutEffect, useState } from "react";
import type { SetURLSearchParams } from "react-router";

import type { OpenPanelTabInput } from "./room-connectivity";
import { openPanelTab as persistOpenPanelTab } from "./task-sidebar/panel-tab-store";
import { panelTabTitle } from "./task-sidebar/panel-tab-title";
import type { PanelTabScope } from "./task-sidebar/panel-tab-types";

export function useRoomPanelSidebar({
  profileOpen,
  scope,
  searchParams,
  setSearchParams,
}: {
  profileOpen: boolean;
  scope: PanelTabScope;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTabRevision, setPanelTabRevision] = useState(0);
  const panelVisible = panelOpen && !profileOpen;
  const [sidebarMounted, setSidebarMounted] = useState(panelVisible);
  useLayoutEffect(() => {
    if (panelVisible) setSidebarMounted(true);
  }, [panelVisible]);
  const onPanelExitAnimationEnd = useCallback(
    () => setSidebarMounted(false),
    [],
  );
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [initialActiveMessageId, setInitialActiveMessageId] = useState<
    string | null
  >(null);

  const openPanelTab = useCallback(
    (input: OpenPanelTabInput) => {
      const title =
        input.title ??
        (input.kind === "file"
          ? (input.documentId ?? "Document")
          : panelTabTitle(input.anchorMessageId ?? "Untitled"));
      persistOpenPanelTab(scope, {
        kind: input.kind,
        activityRunStatusId: input.activityRunStatusId,
        activityRunId: input.activityRunId,
        activityRoomId: input.activityRoomId,
        taskId: input.taskId,
        actorId: input.actorId,
        anchorMessageId: input.anchorMessageId,
        documentId: input.documentId,
        preserveAgentInfoActivity: input.preserveAgentInfoActivity,
        previewUrl: input.previewUrl,
        title,
        versionId: input.versionId,
        previewCurrentVersion: input.previewCurrentVersion,
      });
      setPanelTabRevision((value) => value + 1);
      if (input.anchorMessageId) {
        setFocusMessageId(input.anchorMessageId);
        if (input.kind === "thread") {
          setInitialActiveMessageId(input.anchorMessageId);
        }
      }
      setPanelOpen(true);
      if (searchParams.has("profile")) {
        const next = new URLSearchParams(searchParams);
        next.delete("profile");
        setSearchParams(next);
      }
    },
    [scope, searchParams, setSearchParams],
  );

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setInitialActiveMessageId(null);
  }, []);

  const onActiveMessageChange = useCallback((messageId: string | null) => {
    setFocusMessageId(messageId);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => !open);
  }, []);

  return {
    closePanel,
    focusMessageId,
    onActiveMessageChange,
    openPanelTab,
    panelOpen,
    panelTabRevision,
    panelVisible,
    sidebarMounted,
    onPanelExitAnimationEnd,
    initialActiveMessageId,
    togglePanel,
  };
}
