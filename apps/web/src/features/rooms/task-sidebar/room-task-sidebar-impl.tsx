import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  type TeamHubMessagePresentation,
  useTeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import { useRoomMentionOptions } from "../chat/use-room-mention-options";
import {
  roomDocumentsQueryOptions,
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
} from "../room-queries";
import {
  isPanelCreateChoiceEnabled,
  type PanelCreateChoice,
} from "./panel-create-items";
import {
  closePanelTab,
  ensureDefaultAgentInfoTab,
  movePanelTab,
  openPanelTab,
  readPanelTabState,
  restoreClosedPanelTab,
  retargetAgentInfoTab,
  setActivePanelTab,
} from "./panel-tab-store";
import {
  PANEL_COLLECTION_TAB_TITLES,
  panelTabKey,
  type PanelTabScope,
  type PanelTabState,
} from "./panel-tab-types";
import { panelTabTitle } from "./panel-tab-title";
import { TaskSidebar } from "./task-sidebar";
import { usePanelTaskBindings } from "./use-panel-task-bindings";

const EMPTY_MESSAGE_PRESENTATIONS: Readonly<
  Record<string, TeamHubMessagePresentation>
> = {};

interface RoomTaskSidebarImplProps {
  accountId: string;
  activeMessageId?: string | null;
  directPeer?: TeamHubActorRef;
  focusMessageId?: string | null;
  messagePresentations?: Record<string, TeamHubMessagePresentation>;
  onActiveMessageChange?: (messageId: string | null) => void;
  onCollapse: () => void;
  onReady?: () => void;
  onExitAnimationEnd?: () => void;
  onOpenProfile: (actorId: string) => void;
  onOpenRoomSettings?: () => void;
  panelTabRevision?: number;
  panelVisible?: boolean;
  initiallyOpen?: boolean;
  roomId: string;
  roomName: string;
  tenantId: string;
}

export function RoomTaskSidebarImpl({
  accountId,
  activeMessageId,
  directPeer,
  focusMessageId = null,
  messagePresentations = EMPTY_MESSAGE_PRESENTATIONS,
  onActiveMessageChange,
  onCollapse,
  onReady,
  onExitAnimationEnd,
  onOpenProfile,
  onOpenRoomSettings,
  panelTabRevision = 0,
  panelVisible = true,
  initiallyOpen,
  roomId,
  roomName,
  tenantId,
}: RoomTaskSidebarImplProps) {
  const { client } = useTeamHubRuntime();
  const scope: PanelTabScope = useMemo(
    () => ({ accountId, roomId, tenantId }),
    [accountId, roomId, tenantId],
  );
  const [tabState, setTabState] = useState<PanelTabState>(() =>
    ensureDefaultAgentInfoTab(
      scope,
      directPeer?.kind === "agent" ? directPeer : undefined,
    ),
  );
  const dismissedTabIdsRef = useRef(new Set<string>());
  const messages = useSuspenseInfiniteQuery(
    roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
  );
  const { data: members } = useSuspenseQuery(
    roomMembersQueryOptions(client, tenantId, roomId),
  );
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const { data: actors } = useSuspenseQuery(
    tenantActorsQueryOptions(client, tenantId),
  );
  const { data: documents } = useSuspenseQuery(
    roomDocumentsQueryOptions(client, tenantId, roomId),
  );
  const currentActorId = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const { mentionOptions } = useRoomMentionOptions({
    client,
    members,
    tenantId,
  });
  useEffect(() => {
    const current = ensureDefaultAgentInfoTab(
      scope,
      directPeer?.kind === "agent" ? directPeer : undefined,
    );
    for (const id of current.openTabIds) {
      dismissedTabIdsRef.current.delete(id);
    }
    setTabState(current);
  }, [directPeer, panelTabRevision, scope]);
  const resolveActiveMessageTitle = useEffectEvent((messageId: string) => {
    return (
      messages.data.pages
        .flatMap((page) => page.items)
        .find((message) => message.id === messageId)?.raw_message ?? messageId
    );
  });
  useEffect(() => {
    if (!activeMessageId) return;
    const requestedTabId = panelTabKey("thread", {
      anchorMessageId: activeMessageId,
    });
    const current = readPanelTabState(scope);
    // URL/header seeding persists the tab first. Do not resurrect it after close.
    if (
      dismissedTabIdsRef.current.has(requestedTabId) ||
      !current.openTabIds.includes(requestedTabId)
    ) {
      setTabState(current);
      return;
    }
    const active = current.activeTabId
      ? current.tabs[current.activeTabId]
      : undefined;
    // A + created collection/draft, or another anchored view, must keep focus.
    if (active && active.id !== requestedTabId) {
      setTabState(current);
      return;
    }
    if (dismissedTabIdsRef.current.has(requestedTabId)) {
      setTabState(readPanelTabState(scope));
      return;
    }
    const title = resolveActiveMessageTitle(activeMessageId);
    setTabState(
      openPanelTab(scope, {
        kind: "thread",
        anchorMessageId: activeMessageId,
        title: panelTabTitle(title),
      }),
    );
  }, [activeMessageId, scope]);
  const {
    flatMessages,
    taskResolutions,
    tasksByMessageId,
    unresolvedResolution,
  } = usePanelTaskBindings({
    activeMessageId,
    fetchNextPage: messages.fetchNextPage,
    focusMessageId,
    hasNextPage: Boolean(messages.hasNextPage),
    isFetchNextPageError: messages.isFetchNextPageError,
    isFetchingNextPage: messages.isFetchingNextPage,
    pages: messages.data.pages,
    presentations: messagePresentations,
    tabs: tabState.tabs,
  });
  const lastActivatedAt = useMemo(
    () =>
      Object.fromEntries(
        Object.values(tabState.tabs).map((tab) => [
          tab.id,
          tab.lastActivatedAt,
        ]),
      ),
    [tabState.tabs],
  );
  const tabs = tabState.openTabIds
    .map((id) => tabState.tabs[id])
    .filter((tab): tab is NonNullable<typeof tab> => Boolean(tab));
  useEffect(() => {
    let next = readPanelTabState(scope);
    let changed = false;
    if (directPeer?.kind === "agent") {
      const peerActor = actors.items.find(
        (actor) => actor.id === directPeer.id && actor.kind === "agent",
      );
      if (peerActor) {
        const stale = Object.values(next.tabs).filter(
          (tab) =>
            tab.kind === "agentInfo" &&
            tab.actorId !== directPeer.id &&
            !actors.items.some(
              (actor) => actor.id === tab.actorId && actor.kind === "agent",
            ),
        );
        for (const tab of stale) {
          next = tab.actorId
            ? retargetAgentInfoTab(scope, tab.actorId, directPeer)
            : closePanelTab(scope, tab.id);
          changed = true;
        }
      }
    }
    if (changed) setTabState(next);
  }, [actors.items, directPeer, panelTabRevision, scope]);
  function createChoice(choice: PanelCreateChoice) {
    const next = openPanelCreationChoice(scope, choice, directPeer);
    if (!next) return;
    setTabState(next);
    onActiveMessageChange?.(null);
  }
  return (
    <TaskSidebar
      initiallyOpen={initiallyOpen}
      accountId={accountId}
      activeTabId={tabState.activeTabId}
      actors={actors.items}
      directPeer={directPeer}
      documents={documents.items}
      currentActorId={currentActorId}
      lastActivatedAt={lastActivatedAt}
      mentionOptions={mentionOptions}
      onAgentInfoActivityChange={(actorId, next) => {
        const actor = actors.items.find(
          (candidate) => candidate.id === actorId,
        );
        const name = actor?.display_name || "Agent";
        setTabState(
          openPanelTab(scope, {
            kind: "agentInfo",
            actorId,
            activityRunStatusId: next?.runStatusId,
            anchorMessageId: next?.messageId,
            title: `Agent · ${name}`,
          }),
        );
        if (next?.messageId) onActiveMessageChange?.(next.messageId);
      }}
      onAgentActivityChange={(actorId, next) => {
        const name =
          actors.items.find((actor) => actor.id === actorId)?.display_name ||
          "Agent";
        setTabState(
          openPanelTab(scope, {
            kind: "agentActivity",
            actorId,
            activityRunStatusId: next?.runStatusId,
            activityRoomId: next?.activityRoomId,
            anchorMessageId: next?.messageId,
            title: `Activity · ${name}`,
          }),
        );
        if (
          next?.messageId &&
          (!next.activityRoomId || next.activityRoomId === roomId)
        )
          onActiveMessageChange?.(next.messageId);
      }}
      onActiveChange={(tabId) => {
        const next = setActivePanelTab(scope, tabId);
        setTabState(next);
        const tab = next.tabs[tabId];
        onActiveMessageChange?.(tab?.anchorMessageId ?? null);
      }}
      onReorderTab={(tabId, targetId) =>
        setTabState(movePanelTab(scope, tabId, targetId))
      }
      onCloseTab={(tabId) => {
        dismissedTabIdsRef.current.add(tabId);
        closePanelTab(scope, tabId);
        const next = ensureDefaultAgentInfoTab(
          scope,
          directPeer?.kind === "agent" ? directPeer : undefined,
        );
        setTabState(next);
        if (next.activeTabId) {
          onActiveMessageChange?.(
            next.tabs[next.activeTabId]?.anchorMessageId ?? null,
          );
        } else {
          onActiveMessageChange?.(null);
        }
      }}
      onCollapse={onCollapse}
      onReady={onReady}
      onCreate={createChoice}
      onExitAnimationEnd={onExitAnimationEnd}
      onOpenDocument={(document) => {
        setTabState(
          openPanelTab(scope, {
            kind: "file",
            documentId: document.id,
            title: document.title,
          }),
        );
        onActiveMessageChange?.(null);
      }}
      onOpenProfile={onOpenProfile}
      onOpenRoomSettings={onOpenRoomSettings}
      onRestoreClosed={() => {
        const next = restoreClosedPanelTab(scope);
        setTabState(next);
        if (next.activeTabId) {
          onActiveMessageChange?.(
            next.tabs[next.activeTabId]?.anchorMessageId ?? null,
          );
        }
      }}
      onRetryResolution={
        unresolvedResolution === "error"
          ? () => void messages.fetchNextPage()
          : undefined
      }
      open={panelVisible}
      roomId={roomId}
      roomMembers={members.items.map((member) => member.actor)}
      roomName={roomName}
      roomMessages={flatMessages}
      tabs={tabs}
      taskResolutions={taskResolutions}
      tasksByMessageId={tasksByMessageId}
      tenantId={tenantId}
    />
  );
}

function openPanelCreationChoice(
  scope: PanelTabScope,
  choice: PanelCreateChoice,
  directPeer?: TeamHubActorRef,
): PanelTabState | null {
  if (!isPanelCreateChoiceEnabled(choice, directPeer?.kind === "agent"))
    return null;
  if (choice === "agentInfo") {
    if (directPeer?.kind !== "agent") return null;
    return openPanelTab(scope, {
      kind: "agentInfo",
      actorId: directPeer.id,
      title: `Agent · ${directPeer.display_name}`,
    });
  }
  return openPanelTab(scope, {
    kind: choice,
    title: PANEL_COLLECTION_TAB_TITLES[choice],
  });
}
