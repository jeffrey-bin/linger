import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowUp02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { roomMessagesInfiniteQueryOptions } from "../room-queries";
import { Icon } from "@/components/ui/icon";
import type {
  TeamHubActor,
  TeamHubActorRef,
  TeamHubDocument,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "../members/actor-avatar";
import {
  AgentActivityLog,
  AgentInfoPanelTab,
} from "./adapters/agent-info-panel-tab";
import { AgentLiveActivityPanelTab } from "./adapters/agent-live-activity-panel-tab";
import { FileLibraryPanelTab } from "./adapters/file-library-panel-tab";
import { MessageActivitiesPanelTab } from "./adapters/message-activities-panel-tab";
import { ThreadPanelTab } from "./adapters/thread-panel-tab";
import { PanelEmptyState } from "./panel-empty-state";
import { PanelResizeHandle } from "./panel-resize-handle";
import { RoomSettingsPanel } from "../room-settings-panel";
import { RoomInfoPanel } from "./room-info-panel";
import type { PanelTask } from "./panel-task";
import { PanelTabStrip, type PanelCreateChoice } from "./panel-tab-strip";
import { isPanelCollectionTab, type PanelTab } from "./panel-tab-types";
import { clampPanelSidebarWidth, readPanelSidebarWidth } from "./panel-width";
import { selectMountedTaskTabs } from "./task-keep-alive";
import type { TaskAnchorResolution } from "./task-tab-types";
import { UrlPreviewPanel } from "./url-preview-panel";
import { PanelLoading } from "./panel-loading";

// Opening Agent info or tasks should not load the document editor.
const TaskActivitiesPanelTab = lazy(() =>
  import("./adapters/task-activities-panel-tab").then((module) => ({
    default: module.TaskActivitiesPanelTab,
  })),
);

const ConnectedFilePanelTab = lazy(async () => ({
  default: (await import("./adapters/file-panel-tab")).ConnectedFilePanelTab,
}));

const KEEP_ALIVE_WINDOW = 3;
const CollaborationPanel = lazy(() =>
  import("./collaboration-panel").then((module) => ({
    default: module.CollaborationPanel,
  })),
);
/** Matches the panel reveal/collapse duration declared in globals.css. */
const PANEL_COLLAPSE_MS = 450;
const EMPTY_TASK_RESOLUTIONS: Readonly<Record<string, TaskAnchorResolution>> =
  {};
const EMPTY_ROOM_MESSAGES: readonly TeamHubMessage[] = [];

function resolvePanelAgentActor(
  actors: readonly TeamHubActor[],
  actorId?: string,
  directPeer?: TeamHubActorRef,
) {
  return (
    actors.find(
      (candidate) => candidate.id === actorId && candidate.kind === "agent",
    ) ??
    (directPeer?.kind === "agent"
      ? actors.find(
          (candidate) =>
            candidate.id === directPeer.id && candidate.kind === "agent",
        )
      : undefined)
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function shouldDeferEscape(event: KeyboardEvent) {
  if (event.defaultPrevented) return true;
  if (document.querySelector("dialog[open]")) return true;
  return (
    event.target instanceof Element && Boolean(event.target.closest("dialog"))
  );
}

interface TaskSidebarProps {
  initiallyOpen?: boolean;
  accountId: string;
  activeTabId: string | null;
  actors: TeamHubActor[];
  directPeer?: TeamHubActorRef;
  documents: TeamHubDocument[];
  currentActorId?: string;
  lastActivatedAt: Record<string, number>;
  mentionOptions: TeamHubActorRef[];
  onActiveChange: (tabId: string) => void;
  onAgentInfoActivityChange?: (
    actorId: string,
    next?: { runStatusId?: string; messageId?: string },
  ) => void;
  onAgentActivityChange?: (
    actorId: string,
    next?: {
      runStatusId?: string;
      messageId?: string;
      activityRoomId?: string;
    },
  ) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTab?: (tabId: string, targetId: string) => void;
  onCollapse: () => void;
  onCreate: (choice: PanelCreateChoice) => void;
  onExitAnimationEnd?: () => void;
  onOpenDocument?: (document: TeamHubDocument) => void;
  onOpenProfile?: (actorId: string) => void;
  onOpenRoomSettings?: () => void;
  onReady?: () => void;
  onRestoreClosed?: () => void;
  onRetryResolution?: () => void;
  open?: boolean;
  roomId: string;
  roomMembers: TeamHubActorRef[];
  roomMessages?: readonly TeamHubMessage[];
  roomName: string;
  tabs: PanelTab[];
  taskResolutions?: Record<string, TaskAnchorResolution>;
  tasksByMessageId: Record<string, PanelTask>;
  tenantId: string;
}

export function TaskSidebar({
  initiallyOpen = false,
  accountId,
  activeTabId,
  actors,
  directPeer,
  documents,
  currentActorId,
  lastActivatedAt,
  mentionOptions,
  onActiveChange,
  onAgentInfoActivityChange = () => undefined,
  onAgentActivityChange = () => undefined,
  onCloseTab,
  onReorderTab,
  onCollapse,
  onCreate,
  onExitAnimationEnd,
  onOpenDocument,
  onOpenProfile,
  onOpenRoomSettings,
  onReady,
  onRestoreClosed,
  onRetryResolution,
  open = true,
  roomId,
  roomMembers,
  roomMessages = EMPTY_ROOM_MESSAGES,
  roomName,
  tabs,
  taskResolutions = EMPTY_TASK_RESOLUTIONS,
  tasksByMessageId,
  tenantId,
}: TaskSidebarProps) {
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readPanelSidebarWidth(accountId),
  );
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const focusActiveTabRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  const sidebarWidth = clampPanelSidebarWidth(preferredWidth);
  const reduceMotion = useReducedMotion();
  const exitAnimationEndRef = useRef(onExitAnimationEnd);
  useLayoutEffect(() => {
    exitAnimationEndRef.current = onExitAnimationEnd;
  }, [onExitAnimationEnd]);
  const openTabIds = tabs.map((tab) => tab.id);
  const tabsById = Object.fromEntries(tabs.map((tab) => [tab.id, tab]));
  const activeTab = activeTabId ? tabsById[activeTabId] : undefined;
  const launcherOpen = tabs.length === 0;
  const mountedIds = selectMountedTaskTabs({
    activeTabId,
    lastActivatedAt,
    openTabIds,
    windowSize: KEEP_ALIVE_WINDOW,
  });
  const mountedIdSet = new Set(mountedIds);

  useLayoutEffect(() => {
    activeTabIdRef.current = activeTabId;
    if (!launcherOpen && activeTabId && focusActiveTabRef.current) {
      focusActiveTabRef.current = false;
      document.getElementById(`panel-tab-${activeTabId}`)?.focus();
    }
  }, [activeTabId, launcherOpen]);

  useLayoutEffect(() => {
    if (open) onReady?.();
  }, [onReady, open]);

  function closeTab(tabId: string) {
    const closing = tabsById[tabId];
    const sourceActivities =
      closing?.kind === "thread" && closing.anchorMessageId
        ? tabs.filter(
            (tab) =>
              tab.anchorMessageId === closing.anchorMessageId &&
              Boolean(tab.activityRunId || tab.activityRunStatusId),
          )
        : [];
    for (const activity of sourceActivities) {
      // A live Thread Activity observes its source conversation's Run Statuses.
      // Exit Activity together with that source instead of leaving a frozen view.
      if (activity.kind === "agentInfo" && activity.actorId) {
        onAgentInfoActivityChange(activity.actorId);
      } else {
        onCloseTab(activity.id);
      }
    }
    if (openTabIds.length > 1 && tabId === activeTabId) {
      const index = openTabIds.indexOf(tabId);
      const neighbor = openTabIds[index + 1] ?? openTabIds[index - 1];
      if (neighbor) {
        focusActiveTabRef.current = true;
        onActiveChange(neighbor);
      }
    }
    onCloseTab(tabId);
    // Closing the last tab closes the panel instead of leaving the empty
    // Conversation details behind.
    if (
      openTabIds.length ===
      1 + sourceActivities.filter((tab) => tab.kind !== "agentInfo").length
    )
      collapseSidebar();
  }

  function collapseSidebar() {
    onCollapse();
  }

  usePanelKeyboardShortcuts({
    activeTabId,
    closeActiveTab: closeTab,
    onActiveChange,
    onCollapse: () => {
      if (maximized) setMaximized(false);
      else collapseSidebar();
    },
    onRestoreClosed,
    openTabIds,
  });

  const activeAnchorId = activeTab?.anchorMessageId;
  const activeResolution =
    activeAnchorId != null ? taskResolutions[activeAnchorId] : undefined;

  // Paint one parked frame before revealing. A freshly inserted element does not
  // transition on its first style resolution, so without that frame the panel
  // would appear already open and only animate once something re-rendered it.
  const [expanded, setExpanded] = useState(open && initiallyOpen);
  useLayoutEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    if (reduceMotion) {
      setExpanded(true);
      return;
    }
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [open, reduceMotion]);

  useEffect(() => {
    if (open) return;
    // transitionend carries the collapse; the timer covers hidden or
    // transition-free environments where it never fires.
    const timer = setTimeout(
      () => exitAnimationEndRef.current?.(),
      reduceMotion ? 0 : PANEL_COLLAPSE_MS + 80,
    );
    return () => clearTimeout(timer);
  }, [open, reduceMotion]);

  return (
    <aside
      aria-busy={activeResolution === "loading" || undefined}
      aria-label="Panel sidebar"
      className={`panel-sidebar relative h-full min-h-0 shrink-0 ${activeTab?.kind === "agentInfo" ? "bg-card" : "bg-sidebar"}`}
      data-dragging={dragging || undefined}
      data-open={expanded ? "true" : "false"}
      data-voice-closable={expanded || undefined}
      data-maximized={maximized || undefined}
      inert={!open || undefined}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "margin-right" || open) return;
        exitAnimationEndRef.current?.();
      }}
      ref={sidebarRef}
      style={
        {
          "--panel-sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      {!maximized ? (
        <PanelResizeHandle
          accountId={accountId}
          onDraggingChange={setDragging}
          onWidthChange={setPreferredWidth}
          width={preferredWidth}
        />
      ) : null}
      <div
        className={`panel-sidebar-body flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden pb-1 ${activeTab?.kind === "agentInfo" ? "pr-1" : "px-1"}`}
      >
        <PanelTabStrip
          includeAgentInfo={directPeer?.kind === "agent"}
          activeTabId={activeTabId}
          launcherOpen={launcherOpen}
          maximized={maximized}
          onActivate={(tabId) => {
            onActiveChange(tabId);
          }}
          onClose={closeTab}
          onReorder={onReorderTab}
          onCollapse={collapseSidebar}
          onCreate={(choice) => {
            const requestedActiveTabId = activeTabId;
            focusActiveTabRef.current = true;
            onCreate(choice);
            requestAnimationFrame(() => {
              if (
                requestedActiveTabId &&
                activeTabIdRef.current === requestedActiveTabId
              ) {
                focusActiveTabRef.current = false;
                document
                  .getElementById(`panel-tab-${requestedActiveTabId}`)
                  ?.focus();
              }
            });
          }}
          onToggleMaximize={() => setMaximized((value) => !value)}
          tabs={tabs}
        />

        <div
          className={`panel-content-surface relative flex min-h-0 flex-1 flex-col overflow-hidden bg-card ${activeTab?.kind === "agentInfo" ? "" : "rounded-lg rounded-br-2xl shadow-outline"}`}
          data-testid="panel-content-surface"
        >
          {launcherOpen ? (
            <PanelEmptyState
              agent={
                directPeer?.kind === "agent"
                  ? (resolvePanelAgentActor(
                      actors,
                      directPeer.id,
                      directPeer,
                    ) ?? directPeer)
                  : undefined
              }
              documentCount={documents.length}
              onOpenAgentInfo={() => {
                if (directPeer?.kind !== "agent") return;
                focusActiveTabRef.current = true;
                onAgentInfoActivityChange(directPeer.id);
              }}
              onCreate={(choice) => {
                focusActiveTabRef.current = true;
                onCreate(choice);
              }}
            />
          ) : (
            tabs.map((tab) => {
              const tabId = tab.id;
              const hidden = tabId !== activeTabId;
              return (
                <div
                  aria-labelledby={`panel-tab-${tabId}`}
                  className={hidden ? "hidden" : "flex h-full min-h-0 flex-col"}
                  hidden={hidden || undefined}
                  id={`panel-view-${tabId}`}
                  inert={hidden || undefined}
                  key={tabId}
                  role="tabpanel"
                >
                  {mountedIdSet.has(tabId) ? (
                    <MountedPanelTab
                      accountId={accountId}
                      sidebarOpen={open}
                      activeTabId={activeTabId}
                      activityRoomId={
                        open &&
                        (activeTab?.activityRunId ||
                          activeTab?.activityRunStatusId)
                          ? activeTab.activityRoomId
                          : undefined
                      }
                      actors={actors}
                      directPeer={directPeer}
                      documents={documents}
                      currentActorId={currentActorId}
                      mentionOptions={mentionOptions}
                      onAgentInfoActivityChange={onAgentInfoActivityChange}
                      onAgentActivityChange={onAgentActivityChange}
                      roomMembers={roomMembers}
                      roomMessages={roomMessages}
                      onOpenDocument={onOpenDocument}
                      onOpenProfile={onOpenProfile}
                      onOpenRoomSettings={onOpenRoomSettings}
                      onRetryResolution={onRetryResolution}
                      roomId={roomId}
                      roomName={roomName}
                      tab={tab}
                      tabId={tabId}
                      taskResolutions={taskResolutions}
                      tasksByMessageId={tasksByMessageId}
                      tenantId={tenantId}
                    />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}

function usePanelKeyboardShortcuts({
  activeTabId,
  closeActiveTab,
  onActiveChange,
  onCollapse,
  onRestoreClosed,
  openTabIds,
}: {
  activeTabId: string | null;
  closeActiveTab: (tabId: string) => void;
  onActiveChange: (tabId: string) => void;
  onCollapse: () => void;
  onRestoreClosed?: () => void;
  openTabIds: string[];
}) {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "k") return;

    if (event.key === "Escape") {
      if (shouldDeferEscape(event)) return;
      event.preventDefault();
      if (activeTabId) closeActiveTab(activeTabId);
      else onCollapse();
      return;
    }

    if (meta && event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      onRestoreClosed?.();
      return;
    }

    if (
      !meta ||
      !event.altKey ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
      isEditableTarget(event.target) ||
      !activeTabId
    ) {
      return;
    }
    const index = openTabIds.indexOf(activeTabId);
    if (index < 0) return;
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % openTabIds.length
        : (index - 1 + openTabIds.length) % openTabIds.length;
    const nextId = openTabIds[nextIndex];
    if (nextId && nextId !== activeTabId) {
      event.preventDefault();
      onActiveChange(nextId);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

interface MountedPanelTabProps {
  sidebarOpen: boolean;
  activityRoomId?: string;
  accountId: string;
  activeTabId: string | null;
  actors: TeamHubActor[];
  directPeer?: TeamHubActorRef;
  documents: TeamHubDocument[];
  currentActorId?: string;
  mentionOptions: TeamHubActorRef[];
  onAgentInfoActivityChange: (
    actorId: string,
    next?: { runStatusId?: string; messageId?: string },
  ) => void;
  onAgentActivityChange: (
    actorId: string,
    next?: {
      runStatusId?: string;
      messageId?: string;
      activityRoomId?: string;
    },
  ) => void;
  onOpenDocument?: (document: TeamHubDocument) => void;
  onOpenProfile?: (actorId: string) => void;
  onOpenRoomSettings?: () => void;
  onRetryResolution?: () => void;
  roomId: string;
  roomMembers: TeamHubActorRef[];
  roomMessages: readonly TeamHubMessage[];
  roomName: string;
  tab: PanelTab | undefined;
  tabId: string;
  taskResolutions: Record<string, TaskAnchorResolution>;
  tasksByMessageId: Record<string, PanelTask>;
  tenantId: string;
}

function MountedPanelTab({
  sidebarOpen,
  activityRoomId,
  accountId,
  activeTabId,
  actors,
  directPeer,
  documents,
  currentActorId,
  mentionOptions,
  onAgentInfoActivityChange,
  onAgentActivityChange,
  onOpenDocument,
  onOpenProfile,
  onOpenRoomSettings,
  onRetryResolution,
  roomId,
  roomMembers,
  roomMessages,
  roomName,
  tab,
  tabId,
  taskResolutions,
  tasksByMessageId,
  tenantId,
}: MountedPanelTabProps) {
  if (!tab) return null;
  const hidden = tabId !== activeTabId;

  if (tab.kind === "taskActivity" && tab.taskId) {
    return (
      <Suspense fallback={<PanelLoading label="Loading task" />}>
        <TaskActivitiesPanelTab
          hidden={hidden || !sidebarOpen}
          taskId={tab.taskId}
          tenantId={tenantId}
        />
      </Suspense>
    );
  }

  if (tab.kind === "agentActivity") {
    const actor = resolvePanelAgentActor(actors, tab.actorId, directPeer);
    return (
      <AgentActivityTab
        actorId={actor?.id ?? tab.actorId ?? ""}
        actorName={actor?.display_name ?? "Agent"}
        hidden={hidden || !sidebarOpen}
        onChange={onAgentActivityChange}
        roomId={roomId}
        roomMessages={roomMessages}
        tab={tab}
        tenantId={tenantId}
      />
    );
  }

  if (tab.kind === "agentInfo") {
    const actor = resolvePanelAgentActor(actors, tab.actorId, directPeer);
    const activityActorId = actor?.id ?? tab.actorId ?? "";
    const actorName = actor?.display_name ?? "Agent";
    const nestedActivityMessage = tab.anchorMessageId
      ? roomMessages.find((message) => message.id === tab.anchorMessageId)
      : undefined;
    const activityOpen = Boolean(
      tab.activityRunId || tab.activityRunStatusId || nestedActivityMessage,
    );
    return (
      <>
        <AgentInfoPanelTab
          actor={actor}
          hidden={hidden || activityOpen}
          roomId={roomId}
          tenantId={tenantId}
        />
        {activityOpen && (tab.activityRunId || tab.activityRunStatusId) ? (
          <AgentLiveActivityPanelTab
            activationKey={tab.lastActivatedAt}
            actorId={activityActorId}
            actorName={actorName}
            runStatusId={tab.activityRunStatusId}
            runId={tab.activityRunId}
            hidden={hidden}
            messages={roomMessages}
            messagesRoomId={roomId}
            onBack={() => onAgentInfoActivityChange(activityActorId)}
            roomId={tab.activityRoomId ?? roomId}
            tenantId={tenantId}
          />
        ) : activityOpen && nestedActivityMessage ? (
          <MessageActivitiesPanelTab
            activationKey={tab.lastActivatedAt}
            hidden={hidden}
            message={nestedActivityMessage}
            onBack={() => onAgentInfoActivityChange(activityActorId)}
            roomId={roomId}
            tenantId={tenantId}
          />
        ) : null}
      </>
    );
  }

  if (isPanelCollectionTab(tab)) {
    if (tab.kind === "collaboration") {
      return (
        <Suspense fallback={<PanelLoading label="Loading collaboration" />}>
          <CollaborationPanel
            actors={roomMembers}
            hidden={hidden || !sidebarOpen}
            roomId={roomId}
            tenantId={tenantId}
          />
        </Suspense>
      );
    }
    if (tab.kind === "roomSettings")
      return (
        <RoomSettingsPanel
          onOpenProfile={onOpenProfile}
          roomId={roomId}
          tenantId={tenantId}
        />
      );
    if (tab.kind === "roomInfo") {
      return (
        <RoomInfoPanel
          documents={documents}
          hidden={hidden}
          members={roomMembers}
          onOpenDocument={onOpenDocument}
          onOpenRoomSettings={onOpenRoomSettings}
          roomName={roomName}
        />
      );
    }
    if (tab.kind === "url") {
      return <UrlPreviewPanel hidden={hidden} url={tab.previewUrl} />;
    }
    if (tab.kind === "file") {
      return (
        <FileLibraryPanelTab
          documents={documents}
          hidden={hidden}
          onOpenDocument={onOpenDocument ?? (() => undefined)}
        />
      );
    }
    if (tab.kind === "thread") {
      return (
        <AnothermePanel
          agent={mentionOptions.find((option) => option.kind === "agent")}
          displayName={
            mentionOptions.find((option) => option.id === currentActorId)
              ?.display_name
          }
          hidden={hidden}
        />
      );
    }
    return null;
  }

  if (tab.kind === "file") {
    return (
      <Suspense fallback={<PanelLoading label="Loading file" />}>
        <ConnectedFilePanelTab
          currentActorId={currentActorId}
          documentId={tab.documentId!}
          tenantId={tenantId}
          hidden={hidden}
          versionId={tab.versionId}
          previewCurrentVersion={tab.previewCurrentVersion}
        />
      </Suspense>
    );
  }

  const anchorId = tab.anchorMessageId;
  if (!anchorId) return null;
  const task = tasksByMessageId[anchorId];
  if (!task) {
    return (
      <TaskResolutionBody
        hidden={hidden}
        onRetry={
          taskResolutions[anchorId] === "error" ? onRetryResolution : undefined
        }
        resolution={taskResolutions[anchorId] ?? "unavailable"}
        tabId={tabId}
      />
    );
  }

  if (tab.kind === "thread") {
    return (
      <ThreadPanelTab
        accountId={accountId}
        activityRoomId={activityRoomId}
        anchorMessage={task.anchorMessage}
        hidden={hidden}
        mentionOptions={mentionOptions}
        onOpenProfile={onOpenProfile}
        rootMentions={task.rootMentions}
        tenantId={tenantId}
      />
    );
  }
  return null;
}

function AnothermePanel({
  agent,
  displayName,
  hidden,
}: {
  agent?: TeamHubActorRef;
  displayName?: string;
  hidden: boolean;
}) {
  return (
    <div
      className={
        hidden
          ? "hidden"
          : "relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-card px-6 pb-20 text-center"
      }
      data-testid="panel-tab-thread-draft"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      {agent ? (
        <ActorAvatar
          actorId={agent.id}
          kind={agent.kind}
          name={agent.display_name}
          size="lg"
        />
      ) : (
        <span className="size-16 rounded-full bg-muted" />
      )}
      <h3 className="mt-5 text-base font-semibold text-foreground">
        Good afternoon{displayName ? `, ${displayName}` : ""}
      </h3>
      <div className="absolute inset-x-3 bottom-3 flex h-12 items-center gap-2 rounded-xl bg-card px-2 shadow-sm">
        <button
          aria-label="Attach to Anotherme message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          disabled
          title="Attach"
          type="button"
        >
          <Icon icon={PlusSignIcon} size={16} />
        </button>
        <span className="min-w-0 flex-1 text-left text-sm text-muted-foreground">
          Message Anotherme
        </span>
        <button
          aria-label="Send Anotherme message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-(--composer-send) text-white opacity-50"
          disabled
          title="Send"
          type="button"
        >
          <Icon icon={ArrowUp02Icon} size={16} />
        </button>
      </div>
    </div>
  );
}

function TaskResolutionBody({
  hidden,
  onRetry,
  resolution,
  tabId,
  title,
}: {
  hidden: boolean;
  onRetry?: () => void;
  resolution: TaskAnchorResolution;
  tabId: string;
  title?: string;
}) {
  const content = {
    error: {
      description: "The complete Room history could not be loaded.",
      title: title ?? "Task could not be loaded",
    },
    loading: {
      description: "Looking through the Room history...",
      title: title ?? "Loading Task",
    },
    unavailable: {
      description: "This Message is not available in the current Room history.",
      title: title ?? "This message no longer exists",
    },
  }[resolution];

  return (
    <div
      className={
        hidden
          ? "hidden"
          : "flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-app-sidebar px-6 text-center"
      }
      data-testid={`panel-resolution-${tabId}`}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div>
        <h3 className="text-sm font-semibold">{content.title}</h3>
        <p className="mt-1.5 max-w-64 text-xs leading-5 text-app-muted">
          {content.description}
        </p>
        {onRetry ? (
          <Button className="mt-3" onClick={onRetry} size="compact">
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AgentActivityTab({
  actorId,
  actorName,
  hidden,
  onChange,
  roomId,
  roomMessages,
  tab,
  tenantId,
}: {
  actorId: string;
  actorName: string;
  hidden: boolean;
  onChange: NonNullable<TaskSidebarProps["onAgentActivityChange"]>;
  roomId: string;
  roomMessages: readonly TeamHubMessage[];
  tab: PanelTab;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const targetRoomId = tab.activityRoomId ?? roomId;
  const query = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, targetRoomId),
    enabled: !hidden && targetRoomId !== roomId,
  });
  const messages =
    targetRoomId === roomId
      ? roomMessages
      : (query.data?.pages.flatMap((page) => page.items) ??
        EMPTY_ROOM_MESSAGES);
  const message = tab.anchorMessageId
    ? messages.find((item) => item.id === tab.anchorMessageId)
    : undefined;
  const back = () => onChange(actorId, { activityRoomId: targetRoomId });
  if (tab.activityRunStatusId || tab.activityRunId)
    return (
      <AgentLiveActivityPanelTab
        activationKey={tab.lastActivatedAt}
        actorId={actorId}
        actorName={actorName}
        runStatusId={tab.activityRunStatusId}
        runId={tab.activityRunId}
        hidden={hidden}
        messages={roomMessages}
        messagesRoomId={roomId}
        onBack={back}
        backLabel="Back to Activity"
        roomId={targetRoomId}
        tenantId={tenantId}
      />
    );
  if (targetRoomId !== roomId && query.isPending && !hidden)
    return <PanelLoading label="Loading activity" />;
  if (targetRoomId !== roomId && query.isError && !query.data && !hidden)
    return (
      <div role="alert" className="p-4 text-sm">
        <p>Activity history could not be loaded.</p>
        <Button tone="secondary" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (message)
    return (
      <MessageActivitiesPanelTab
        activationKey={tab.lastActivatedAt}
        hidden={hidden}
        message={message}
        onBack={back}
        backLabel="Back to Activity"
        roomId={targetRoomId}
        tenantId={tenantId}
      />
    );
  return (
    <div
      aria-label={`${actorName} activity`}
      className={
        hidden ? "hidden" : "workspace-scrollbar h-full min-h-0 overflow-y-auto"
      }
      data-testid="panel-tab-agent-activity"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <AgentActivityLog
        actorId={actorId}
        agentName={actorName}
        onView={(entry) =>
          onChange(
            actorId,
            entry.runStatusId
              ? { runStatusId: entry.runStatusId, activityRoomId: targetRoomId }
              : { messageId: entry.id, activityRoomId: targetRoomId },
          )
        }
        roomId={targetRoomId}
        roomMessages={messages}
        tenantId={tenantId}
      />
      {targetRoomId !== roomId && query.hasNextPage ? (
        <div className="px-4 pb-4">
          <Button
            tone="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? "Loading…"
              : query.isFetchNextPageError
                ? "Retry loading earlier activity"
                : "Load earlier activity"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
