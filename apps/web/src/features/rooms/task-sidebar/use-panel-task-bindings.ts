import { useEffect, useMemo } from "react";

import type { TeamHubMessagePresentation } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import type { PanelTab } from "./panel-tab-types";
import type { PanelTask } from "./panel-task";
import type { TaskAnchorResolution } from "./task-tab-types";

export function usePanelTaskBindings({
  activeMessageId,
  fetchNextPage,
  focusMessageId,
  hasNextPage,
  isFetchNextPageError,
  isFetchingNextPage,
  pages,
  presentations,
  tabs,
}: {
  activeMessageId?: string | null;
  fetchNextPage: () => Promise<unknown>;
  focusMessageId?: string | null;
  hasNextPage: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
  pages: Array<{ items: TeamHubMessage[] }>;
  presentations: Readonly<Record<string, TeamHubMessagePresentation>>;
  tabs: Record<string, PanelTab>;
}): {
  flatMessages: TeamHubMessage[];
  taskResolutions: Record<string, TaskAnchorResolution>;
  tasksByMessageId: Record<string, PanelTask>;
  unresolvedResolution: TaskAnchorResolution;
} {
  const flatMessages = pages.flatMap((page) => page.items);
  const neededMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of Object.values(tabs)) {
      if (tab.anchorMessageId) ids.add(tab.anchorMessageId);
    }
    if (activeMessageId) ids.add(activeMessageId);
    if (focusMessageId) ids.add(focusMessageId);
    return ids;
  }, [activeMessageId, focusMessageId, tabs]);
  const unresolvedIds = [...neededMessageIds].filter(
    (id) => !flatMessages.some((message) => message.id === id),
  );
  useEffect(() => {
    if (
      unresolvedIds.length > 0 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    ) {
      void fetchNextPage();
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    unresolvedIds.length,
  ]);
  const tasksByMessageId = useMemo(() => {
    const next: Record<string, PanelTask> = {};
    for (const message of flatMessages) {
      if (neededMessageIds.has(message.id)) {
        next[message.id] = {
          anchorMessage: message,
          rootMentions: presentations[message.id]?.mentions,
        };
      }
    }
    return next;
  }, [flatMessages, neededMessageIds, presentations]);
  const unresolvedResolution: TaskAnchorResolution = isFetchNextPageError
    ? "error"
    : hasNextPage || isFetchingNextPage
      ? "loading"
      : "unavailable";
  const taskResolutions = useMemo(() => {
    const next: Record<string, TaskAnchorResolution> = {};
    for (const id of neededMessageIds) {
      if (!tasksByMessageId[id]) {
        next[id] = unresolvedResolution;
      }
    }
    return next;
  }, [neededMessageIds, tasksByMessageId, unresolvedResolution]);
  return {
    flatMessages,
    taskResolutions,
    tasksByMessageId,
    unresolvedResolution,
  };
}
