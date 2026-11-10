import { SharedStreamingStatusProvider } from "./chat/shared-streaming-status";
import {
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Delete02Icon, SidebarRightIcon } from "@hugeicons/core-free-icons";
import {
  lazy,
  Suspense,
  type CSSProperties,
  type RefObject,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Await,
  Outlet,
  useLoaderData,
  useLocation,
  useMatch,
  useParams,
  useSearchParams,
} from "react-router";

import { RouteContentBoundary } from "@/features/rooms/route-content-boundary";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessagePresentation } from "@/features/teamhub/teamhub-runtime";
import type { RoomRealtimeStatus } from "@/features/teamhub/event-transport";
import type {
  TeamHubActor,
  TeamHubMessage,
  TeamHubRoom,
  TeamHubRoomMember,
  TeamHubRoomPage,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import {
  roomOffersVoiceMaterials,
  VoiceMaterialsProvider,
} from "./chat/voice-mode/voice-materials-context";
import { useOptionalVoiceModeSession } from "./chat/voice-mode/voice-mode-session";
import { RoomRealtimeSync } from "./chat/room-realtime-sync";
import { AgentStatusDot } from "./members/agent-status";
import { RoomAvatar } from "./members/room-avatar";
import { ActorAvatar } from "./members/actor-avatar";
import {
  RoomChromeProvider,
  type OpenPanelTabInput,
  type RoomOutletContext,
} from "./room-connectivity";
import { requireRoomRouteParam } from "./room-route-params";
import {
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryOptions,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
  tenantRoomsQueryKey,
} from "./room-queries";
import { RoomDeleteDialog } from "./room-delete-dialog";
import { useRoomPanelSidebar } from "./use-room-panel-sidebar";
import { useRoomPresence } from "./use-room-presence";
import { readPanelTabState } from "./task-sidebar/panel-tab-store";
import {
  PANEL_COLLECTION_TAB_TITLES,
  panelTabKey,
  type PanelTabScope,
} from "./task-sidebar/panel-tab-types";
import { readPanelSidebarWidth } from "./task-sidebar/panel-width";
import { AuthenticatedRouteLoading } from "./route-loading-surface";
import { RoomPresentationBoundary } from "./room-presentation-boundary";
import { GENERAL_AGENT_DEFAULT_NAME } from "./general-agent-defaults";
import { MobileNavigationButton } from "./mobile-navigation";

// Share the after-chat warmup and immediate-open import. A warmed module renders
// directly, avoiding React.lazy's first-render Suspense delay.
let loadedRoomTaskSidebar:
  | typeof import("./task-sidebar/room-task-sidebar").RoomTaskSidebar
  | undefined;
let roomTaskSidebarModule:
  | Promise<typeof import("./task-sidebar/room-task-sidebar")>
  | undefined;
function loadRoomTaskSidebar() {
  roomTaskSidebarModule ??= import("./task-sidebar/room-task-sidebar").then(
    (module) => {
      loadedRoomTaskSidebar = module.RoomTaskSidebar;
      return module;
    },
  );
  return roomTaskSidebarModule;
}
function prefetchRoomTaskSidebar() {
  // Opening still surfaces a failed import through the route error boundary.
  void loadRoomTaskSidebar().catch(() => {});
}
const LazyRoomTaskSidebar = lazy(async () => ({
  default: (await loadRoomTaskSidebar()).RoomTaskSidebar,
}));

function RoomPanelSidebar(
  props: Parameters<
    typeof import("./task-sidebar/room-task-sidebar").RoomTaskSidebar
  >[0],
) {
  // Keep the component identity for this open session. Switching from lazy to
  // the loaded export after commit would remount the panel and replay its reveal.
  const [Sidebar] = useState(
    () => loadedRoomTaskSidebar ?? LazyRoomTaskSidebar,
  );
  return <Sidebar {...props} />;
}

// The member list and profile open only on request, so they stay out of the
// first load.
const ActorProfilePanel = lazy(async () => ({
  default: (await import("./members/actor-profile")).ActorProfilePanel,
}));

const EMPTY_ACTORS: TeamHubActor[] = [];
const EMPTY_TENANT_AGENTS: TeamHubTenantAgent[] = [];
const EMPTY_AVAILABILITY: TeamHubTenantAgentAvailabilitySnapshot[] = [];

export function RoomSurface() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const params = useParams();
  const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
  const roomId = requireRoomRouteParam(params.roomId, "Room");
  const { client } = useTeamHubRuntime();
  // Runs before the Room bootstrap resolves so preparation starts as early as possible.
  useRoomPresence(client, roomId);
  const loaderData = useLoaderData();

  if (loaderData?.bootstrap && loaderData.initialRoomSeq === undefined) {
    return (
      <RoomPresentationBoundary
        key={`${tenantId}:${roomId}`}
        presentation={loaderData.presentation ?? loaderData.bootstrap}
        fallback={
          <AuthenticatedRouteLoading
            pathname={location.pathname}
            rooms={
              queryClient.getQueryData<TeamHubRoomPage>(
                tenantRoomsQueryKey(tenantId),
              )?.items ?? []
            }
          />
        }
      >
        {(bootstrap) => (
          <RoomSurfaceContent
            bootstrap={bootstrap}
            pendingBootstrap={loaderData.bootstrap}
            key={`${tenantId}:${roomId}`}
            roomId={roomId}
            tenantId={tenantId}
          />
        )}
      </RoomPresentationBoundary>
    );
  }

  return (
    <RoomSurfaceContent
      bootstrap={loaderData}
      pendingBootstrap={loaderData?.bootstrap}
      key={`${tenantId}:${roomId}`}
      roomId={roomId}
      tenantId={tenantId}
    />
  );
}

function useSyncAgentInfoPanelTitle({
  agentProfileActor,
  directAgent,
  directPeer,
  openPanelTab,
  scope,
}: {
  agentProfileActor: TeamHubActor | undefined;
  directAgent: TeamHubTenantAgent | undefined;
  directPeer: TeamHubRoom["direct_peer"];
  openPanelTab: (input: OpenPanelTabInput) => void;
  scope: PanelTabScope;
}) {
  useLayoutEffect(() => {
    if (!agentProfileActor) return;
    openPanelTab({
      kind: "agentInfo",
      actorId: agentProfileActor.id,
      title: `Agent · ${agentProfileActor.display_name}`,
    });
  }, [agentProfileActor, openPanelTab]);
  const agentInfoActorId = useRef<string | undefined>(undefined);
  const agentInfoTitle = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const agent =
      directAgent?.actor ??
      (directPeer?.kind === "agent" ? directPeer : undefined);
    if (!agent) return;
    const title = `Agent · ${agent.display_name}`;
    if (
      agentInfoActorId.current === agent.id &&
      agentInfoTitle.current === title
    ) {
      return;
    }
    if (!agentInfoActorId.current) {
      agentInfoActorId.current = agent.id;
      agentInfoTitle.current = title;
      return;
    }
    if (agentInfoActorId.current === agent.id) {
      agentInfoActorId.current = agent.id;
      agentInfoTitle.current = title;
      const tabId = panelTabKey("agentInfo", { actorId: agent.id });
      if (readPanelTabState(scope).tabs[tabId]) {
        openPanelTab({
          kind: "agentInfo",
          actorId: agent.id,
          preserveAgentInfoActivity: true,
          title,
        });
      }
      return;
    }
    agentInfoActorId.current = agent.id;
    agentInfoTitle.current = title;
    openPanelTab({
      kind: "agentInfo",
      actorId: agent.id,
      preserveAgentInfoActivity: true,
      title,
    });
  }, [directAgent, directPeer, openPanelTab, scope]);
}

interface RoomSurfaceContentProps {
  bootstrap?: { initialRoomSeq?: number };
  pendingBootstrap?: Promise<{ initialRoomSeq: number }>;
  roomId: string;
  tenantId: string;
}

function RoomSurfaceContent({
  bootstrap,
  pendingBootstrap,
  roomId,
  tenantId,
}: RoomSurfaceContentProps) {
  const { client } = useTeamHubRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const isChatView = Boolean(useMatch("/t/:tenantId/rooms/:roomId/chat"));
  const { data: room } = useSuspenseQuery(
    roomQueryOptions(client, tenantId, roomId),
  );
  const { data: members } = useSuspenseQuery(
    roomMembersQueryOptions(client, tenantId, roomId),
  );
  const { data: messageHistory } = useSuspenseInfiniteQuery(
    roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
  );
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const { data: actors } = useQuery(tenantActorsQueryOptions(client, tenantId));
  const { data: tenantAgents } = useQuery(
    tenantAgentsQueryOptions(client, tenantId),
  );
  const { data: tenantAgentAvailability } = useQuery(
    tenantAgentAvailabilityQueryOptions(client, tenantId),
  );
  const actorItems = actors?.items ?? EMPTY_ACTORS;
  const tenantAgentItems = tenantAgents?.items ?? EMPTY_TENANT_AGENTS;
  const availabilityItems =
    tenantAgentAvailability?.items ?? EMPTY_AVAILABILITY;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [panelLoadingRevealed, setPanelLoadingRevealed] = useState(false);
  const revealPanelLoading = useCallback(
    () => setPanelLoadingRevealed(true),
    [],
  );
  const markPanelReady = useCallback(() => setPanelLoadingRevealed(false), []);
  const [realtimeStatus, setRealtimeStatus] =
    useState<RoomRealtimeStatus>("catching-up");
  const [initialRoomSeq] = useState(
    () =>
      bootstrap?.initialRoomSeq ??
      messageHistory.pages[0]?.snapshot_room_seq ??
      0,
  );
  const [lastAppliedRoomSeq, setLastAppliedRoomSeq] = useState(initialRoomSeq);
  const { messagePresentations, recordMessagePresentation } =
    useRoomMessagePresentations();
  const roomSurfaceRef = useRef<HTMLElement>(null);
  const currentActorId = identity.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const profileActor = actorItems.find(
    (actor) => actor.id === searchParams.get("profile"),
  );
  const legacyProfileActor =
    profileActor?.kind === "human" ? profileActor : undefined;
  const agentProfileActor =
    profileActor?.kind === "agent" ? profileActor : undefined;
  const isDirectRoom = room.kind === "direct";
  const directAgent = isDirectRoom
    ? tenantAgentItems.find((agent) => agent.actor.id === room.direct_peer?.id)
    : undefined;
  const directAgentSnapshot = directAgent
    ? availabilityItems.find(
        (snapshot) => snapshot.actor_id === directAgent.actor.id,
      )
    : undefined;
  const directAgentAvailability = directAgentSnapshot?.availability;
  const livePeerName = actorItems.find(
    (actor) => actor.id === room.direct_peer?.id,
  )?.display_name;
  const roomTitle = isDirectRoom && livePeerName ? livePeerName : room.name;
  const presentationRoom =
    roomTitle === room.name ? room : { ...room, name: roomTitle };
  const currentActorIsOwner = members.items.some(
    (member) => member.actor.id === currentActorId && member.role === "owner",
  );
  const canDeleteDeletedAgentRoom =
    isDirectRoom && room.direct_peer_active === false && currentActorIsOwner;

  const scope = useMemo(
    () => ({
      accountId: identity.account.id,
      roomId,
      tenantId,
    }),
    [identity.account.id, roomId, tenantId],
  );
  const {
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
  } = useRoomPanelSidebar({
    profileOpen: Boolean(legacyProfileActor),
    scope,
    searchParams,
    setSearchParams,
  });
  const detailOpen =
    Boolean(legacyProfileActor) || panelVisible || sidebarMounted;
  // Narrow layouts hide the chat behind the panel; follow the requested state so
  // the chat is back under the panel while it slides away.
  const panelLayoutActive = panelVisible;
  const openPanelTabFromRoom = useDetailPanelFocusReturn({
    detailOpen,
    openPanelTab,
    roomSurfaceRef,
  });

  // A canvas delivered while the Room is open opens in the panel at once.
  function openCanvasMessage(message: TeamHubMessage) {
    const canvas = message.segments.find(
      (segment) =>
        segment.type === "document" && segment.presentation === "canvas",
    );
    if (canvas?.type !== "document") return;
    openPanelTabFromRoom({
      kind: "file",
      documentId: canvas.document_id,
      title: canvas.content,
    });
  }

  // A team.md published while the Room is open opens Collaboration at once.
  function openCollaboration() {
    openPanelTabFromRoom({
      kind: "collaboration",
      title: PANEL_COLLECTION_TAB_TITLES.collaboration,
    });
  }

  useSyncAgentInfoPanelTitle({
    agentProfileActor,
    directAgent,
    directPeer: room.direct_peer,
    openPanelTab: openPanelTabFromRoom,
    scope,
  });

  const roomOutletContext: RoomOutletContext = {
    prefetchPanel: prefetchRoomTaskSidebar,
    focusPanelMessageId: focusMessageId,
    lastAppliedRoomSeq,
    messagePresentations,
    openProfile,
    openPanelTab: openPanelTabFromRoom,
    recordMessagePresentation,
    status: realtimeStatus,
  };

  function openProfile(actorId: string) {
    const actor = actorItems.find((candidate) => candidate.id === actorId);
    if (actor?.kind === "agent") {
      openPanelTabFromRoom({
        kind: "agentInfo",
        actorId: actor.id,
        title: `Agent · ${actor.display_name}`,
      });
      return;
    }
    setSearchParams(roomProfileSearchParams(searchParams, actorId));
  }

  function closeProfile() {
    setSearchParams(roomProfileSearchParams(searchParams));
  }

  return (
    <RoomChromeProvider value={roomOutletContext}>
      <RoomCollaborationScope
        accountId={identity.account.id}
        room={room}
        tenantId={tenantId}
        voiceEnabled={isChatView}
      >
        {/* Clip, not hide: a hidden box still scrolls programmatically, so
            focusing a field inside the parked panel (Room settings' Name)
            scrolled this layout 430px and snapped the panel open before its
            slide could run. A clipped box cannot scroll at all. */}
        <div
          className="app-room-layout min-h-0 min-w-0 flex-1 overflow-clip"
          data-detail-open={Boolean(legacyProfileActor) || panelLayoutActive}
        >
          <div className="flex h-full min-h-0 w-full min-w-0">
            <section
              aria-label={`Room ${roomTitle}`}
              className="app-room-surface relative flex min-h-0 min-w-0 flex-1 flex-col border-r border-border/60 bg-app-surface focus:outline-none"
              ref={roomSurfaceRef}
              tabIndex={-1}
            >
              <RoomHeader
                currentActorId={currentActorId}
                directAgent={directAgent}
                directAgentAvailability={directAgentAvailability}
                initialRoomSeq={initialRoomSeq}
                pendingBootstrap={pendingBootstrap}
                isChatView={isChatView}
                members={members.items}
                onAppliedRoomSeq={setLastAppliedRoomSeq}
                onMessageCreated={openCanvasMessage}
                onTeamMdPublished={openCollaboration}
                onOpenAgent={openProfile}
                onOpenDelete={() => setDeleteOpen(true)}
                onOpenSettings={() =>
                  openPanelTab({ kind: "roomSettings", title: "Room settings" })
                }
                onTogglePanel={togglePanel}
                onStatusChange={setRealtimeStatus}
                canDeleteDeletedAgentRoom={canDeleteDeletedAgentRoom}
                panelOpen={panelOpen}
                room={presentationRoom}
                roomId={roomId}
                tenantId={tenantId}
              />

              {/* A layout-neutral wrapper; the desktop app draws it as a card. */}
              <div className="room-surface-card flex min-h-0 min-w-0 flex-1 flex-col">
                <RouteContentBoundary>
                  <Outlet context={roomOutletContext} />
                </RouteContentBoundary>
              </div>
            </section>
            {legacyProfileActor ? (
              <Suspense fallback={null}>
                <ActorProfilePanel
                  actor={legacyProfileActor}
                  onClose={closeProfile}
                  onSelectActor={openProfile}
                  tenantId={tenantId}
                />
              </Suspense>
            ) : null}
            {sidebarMounted ? (
              <Suspense
                fallback={
                  <RoomPanelSidebarFallback
                    accountId={identity.account.id}
                    onReveal={revealPanelLoading}
                    onClose={() => {
                      closePanel();
                      onPanelExitAnimationEnd();
                      markPanelReady();
                    }}
                  />
                }
              >
                <RoomPanelSidebar
                  initiallyOpen={panelLoadingRevealed}
                  onReady={markPanelReady}
                  accountId={identity.account.id}
                  activeMessageId={initialActiveMessageId}
                  focusMessageId={focusMessageId}
                  messagePresentations={messagePresentations}
                  onActiveMessageChange={onActiveMessageChange}
                  onCollapse={closePanel}
                  onExitAnimationEnd={onPanelExitAnimationEnd}
                  onOpenProfile={openProfile}
                  onOpenRoomSettings={
                    room.kind === "room" && currentActorIsOwner
                      ? () =>
                          openPanelTab({
                            kind: "roomSettings",
                            title: "Room settings",
                          })
                      : undefined
                  }
                  panelTabRevision={panelTabRevision}
                  panelVisible={panelVisible}
                  roomId={roomId}
                  roomName={roomTitle}
                  directPeer={
                    room.kind === "direct" && room.direct_peer?.kind === "agent"
                      ? room.direct_peer
                      : undefined
                  }
                  tenantId={tenantId}
                />
              </Suspense>
            ) : null}
            {deleteOpen ? (
              <RoomDeleteDialog
                onClose={() => setDeleteOpen(false)}
                room={room}
                tenantId={tenantId}
              />
            ) : null}
          </div>
        </div>
      </RoomCollaborationScope>
    </RoomChromeProvider>
  );
}

/** Chat and its kept-alive panels share one account/Room-scoped collaboration state. */
function RoomCollaborationScope({
  accountId,
  room,
  tenantId,
  voiceEnabled,
  children,
}: {
  accountId: string;
  room: TeamHubRoom;
  tenantId: string;
  voiceEnabled: boolean;
  children: ReactNode;
}) {
  const voice = useOptionalVoiceModeSession();
  const voiceRoomId = voice?.session?.target.roomId;
  // While Voice Mode runs for another Room, Message text selected here is
  // collected for that Room's next turn.
  const remote =
    voiceRoomId !== undefined &&
    voiceRoomId !== room.id &&
    voice?.session?.target.tenantId === tenantId;
  return (
    <VoiceMaterialsProvider
      scope={{ accountId, roomId: remote ? voiceRoomId : room.id, tenantId }}
      enabled={voiceEnabled && (remote || roomOffersVoiceMaterials(room))}
      remote={remote}
    >
      <SharedStreamingStatusProvider key={`${tenantId}:${room.id}`}>
        {children}
      </SharedStreamingStatusProvider>
    </VoiceMaterialsProvider>
  );
}

function useRoomMessagePresentations() {
  const [messagePresentations, setMessagePresentations] = useState<
    Record<string, TeamHubMessagePresentation>
  >({});
  const recordMessagePresentation = useCallback(
    (messageId: string, presentation: TeamHubMessagePresentation) => {
      setMessagePresentations((current) => ({
        ...current,
        [messageId]: presentation,
      }));
    },
    [],
  );

  return { messagePresentations, recordMessagePresentation };
}

function useDetailPanelFocusReturn({
  detailOpen,
  openPanelTab,
  roomSurfaceRef,
}: {
  detailOpen: boolean;
  openPanelTab: (input: OpenPanelTabInput) => void;
  roomSurfaceRef: RefObject<HTMLElement | null>;
}) {
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const detailWasOpenRef = useRef(false);
  const openPanelTabFromRoom = useCallback(
    (input: OpenPanelTabInput) => {
      const activeElement = document.activeElement;
      detailTriggerRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      openPanelTab(input);
    },
    [openPanelTab],
  );

  useLayoutEffect(() => {
    if (detailOpen && !detailWasOpenRef.current) {
      const activeElement = document.activeElement;
      detailTriggerRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
    } else if (!detailOpen && detailWasOpenRef.current) {
      const trigger = detailTriggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus();
      } else {
        roomSurfaceRef.current?.focus();
      }
      detailTriggerRef.current = null;
    }
    detailWasOpenRef.current = detailOpen;
  }, [detailOpen, roomSurfaceRef]);

  return openPanelTabFromRoom;
}

function roomProfileSearchParams(current: URLSearchParams, actorId?: string) {
  const next = new URLSearchParams(current);
  if (actorId) {
    next.set("profile", actorId);
  } else {
    next.delete("profile");
  }
  return next;
}

function RoomPanelSidebarFallback({
  accountId,
  onClose,
  onReveal,
}: {
  accountId: string;
  onClose: () => void;
  onReveal: () => void;
}) {
  useLayoutEffect(onReveal, [onReveal]);
  return (
    <aside
      aria-busy="true"
      aria-label="Loading panel sidebar"
      className="panel-sidebar relative h-full min-h-0 shrink-0 bg-app-sidebar px-1 pb-1"
      data-open="true"
      style={
        {
          "--panel-sidebar-width": `${readPanelSidebarWidth(accountId)}px`,
        } as CSSProperties
      }
    >
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-2 px-1">
          <span className="text-xs text-app-muted">Sidebar</span>
          <Button
            aria-label="Hide sidebar"
            className="ml-auto !rounded-lg border-0 text-app-muted"
            onClick={onClose}
            size="compactIcon"
            tone="ghost"
          >
            <Icon icon={SidebarRightIcon} size={16} />
          </Button>
        </div>
        <div
          className="flex min-h-0 flex-1 items-center justify-center rounded-xl bg-card/60 text-sm text-app-muted"
          role="status"
        >
          Loading sidebar...
        </div>
      </div>
    </aside>
  );
}

function RoomHeader({
  canDeleteDeletedAgentRoom,
  currentActorId,
  directAgent,
  directAgentAvailability,
  initialRoomSeq,
  pendingBootstrap,
  isChatView,
  members,
  onAppliedRoomSeq,
  onMessageCreated,
  onTeamMdPublished,
  onOpenAgent,
  onOpenDelete,
  onOpenSettings,
  onTogglePanel,
  onStatusChange,
  panelOpen,
  room,
  roomId,
  tenantId,
}: {
  canDeleteDeletedAgentRoom: boolean;
  currentActorId?: string;
  directAgent?: TeamHubTenantAgent;
  directAgentAvailability?: TeamHubTenantAgentAvailabilitySnapshot["availability"];
  initialRoomSeq: number;
  pendingBootstrap?: Promise<{ initialRoomSeq: number }>;
  isChatView: boolean;
  members: TeamHubRoomMember[];
  onAppliedRoomSeq: (roomSeq: number) => void;
  onMessageCreated: (message: TeamHubMessage) => void;
  onTeamMdPublished: () => void;
  onOpenAgent: (actorId: string) => void;
  onOpenDelete: () => void;
  onOpenSettings: () => void;
  onTogglePanel: () => void;
  onStatusChange: (status: RoomRealtimeStatus) => void;
  panelOpen: boolean;
  room: TeamHubRoom;
  roomId: string;
  tenantId: string;
}) {
  const isDirectRoom = room.kind === "direct";
  const headerPeer =
    room.direct_peer?.kind === "agent" ? room.direct_peer : undefined;
  const headerName =
    headerPeer?.display_name &&
    (room.name === headerPeer.display_name ||
      room.name === GENERAL_AGENT_DEFAULT_NAME)
      ? headerPeer.display_name
      : room.name;

  return (
    <header
      className={`room-chat-header room-header ${isChatView ? "room-header--chat" : ""} grid h-(--app-header-height) shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center gap-2 border-b border-transparent bg-app-surface pl-3 pr-4`}
    >
      <div className="flex min-w-0 items-center">
        <MobileNavigationButton />
      </div>
      <div className="flex min-w-0 items-center justify-center gap-2">
        {/* Avatar + name chip; the avatar button covers the whole chip and
            toggles the Agent or Room page in the side panel. */}
        <div className="relative flex h-8 min-w-0 items-center gap-2 rounded-full bg-card pl-1 pr-3 shadow-outline transition-colors duration-150 hover:bg-accent">
          <button
            type="button"
            aria-expanded={panelOpen}
            aria-label={`Open ${headerName} settings from avatar`}
            className="flex shrink-0 items-center justify-center rounded-full after:absolute after:inset-0 after:rounded-full after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-app-focus"
            onClick={() => {
              if (panelOpen) onTogglePanel();
              else if (headerPeer) onOpenAgent(headerPeer.id);
              else onOpenSettings();
            }}
          >
            {headerPeer ? (
              <span className="relative block">
                <ActorAvatar
                  actorId={headerPeer.id}
                  kind="agent"
                  name={headerName}
                  size="xs"
                />
                {directAgent && directAgentAvailability ? (
                  <AgentStatusDot
                    availability={directAgentAvailability}
                    className="absolute -right-0.5 -bottom-0.5"
                  />
                ) : null}
              </span>
            ) : (
              <RoomAvatar
                members={members.map((member) => member.actor)}
                size="header"
              />
            )}
          </button>
          <h1
            aria-label={room.name}
            className="pointer-events-none min-w-0 truncate text-sm leading-[18px] font-medium text-foreground"
          >
            {headerName}
          </h1>
        </div>
        {isDirectRoom && room.direct_peer_active === false ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            Deleted
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {/* Bootstrap sync is background work; the header shows nothing for it. */}
        <Suspense fallback={null}>
          <Await resolve={pendingBootstrap ?? { initialRoomSeq }}>
            {(ready: { initialRoomSeq: number }) =>
              room.participation !== "left" ? (
                <RoomRealtimeSync
                  currentActorId={currentActorId}
                  initialRoomSeq={ready.initialRoomSeq}
                  onAppliedRoomSeq={onAppliedRoomSeq}
                  onMessageCreated={onMessageCreated}
                  onStatusChange={onStatusChange}
                  onTeamMdPublished={onTeamMdPublished}
                  roomId={roomId}
                  tenantId={tenantId}
                />
              ) : null
            }
          </Await>
        </Suspense>
        {canDeleteDeletedAgentRoom ? (
          <Button
            aria-label="Delete Room"
            className="!rounded-lg border-0 text-app-muted"
            onClick={onOpenDelete}
            size="compactIcon"
            title="Delete Room"
            tone="ghost"
          >
            <Icon icon={Delete02Icon} size={16} />
          </Button>
        ) : null}
        {panelOpen ? (
          <span
            aria-hidden="true"
            className="size-8 shrink-0"
            data-panel-trigger-slot
          />
        ) : (
          <Button
            aria-label="Show sidebar"
            aria-pressed={false}
            className="!rounded-lg border-0 text-app-muted"
            onClick={onTogglePanel}
            size="compactIcon"
            title="Show sidebar"
            tone="ghost"
          >
            <Icon className="shrink-0" icon={SidebarRightIcon} size={16} />
          </Button>
        )}
      </div>
    </header>
  );
}
