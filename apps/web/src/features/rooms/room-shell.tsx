import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Outlet,
  useLocation,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";

import { DesktopBarSlot } from "@/app/desktop-frame";
import { isDesktopShell } from "@/app/desktop-shell";
import { AccountMenu } from "@/features/auth/account-menu";
import { LOGOUT_ERROR_MESSAGE, useLogout } from "@/features/auth/use-logout";

import { Button } from "@/components/ui/button";
import { useGlobalSearchShortcut } from "@/features/search/search-shortcut";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubCurrentIdentity,
  TeamHubRoomListItem,
} from "@/features/teamhub/teamhub-types";

import { ActorAvatarImageProvider } from "./members/actor-avatar-image";
import {
  MobileNavigationButton,
  OpenMobileNavigationContext,
} from "./mobile-navigation";
import { routeLayoutKey } from "./route-layout-key";
import { VoiceControlProvider } from "./voice-control/voice-backend-provider";
import { useOptionalVoiceControl } from "./voice-control/voice-control-context";
import { useRecordingWindow } from "./voice-control/recording-window-store";
import {
  useOptionalVoiceModeSession,
  VoiceModeSessionProvider,
} from "./chat/voice-mode/voice-mode-session";
import { registerVoiceShell } from "./chat/voice-mode/voice-ui-bridge";
import { RoomNavigation } from "./room-navigation";
import {
  AuthenticatedRouteLoading,
  RoomNavigationLoading,
} from "./route-loading-surface";
import { TeamHubEventSync } from "./event-sync";
import { requireRoomRouteParam } from "./room-route-params";
import { useScrollPaneActivity } from "./use-scroll-pane-activity";
import {
  anotherMeQueryOptions,
  teamHubTenantQueryOptions,
  teamHubIdentityQueryOptions,
  tenantRoomsQueryOptions,
} from "./room-queries";

// Opened on demand, so these stay off the initial JavaScript graph.
const VoiceModeMiniWindow = lazy(
  () => import("./chat/voice-mode/voice-mode-mini-window"),
);
const RecordingWindow = lazy(() => import("./voice-control/recording-window"));
const RoomCreateDialog = lazy(async () => ({
  default: (await import("./room-create-dialog")).RoomCreateDialog,
}));
const GlobalSearchDialog = lazy(async () => ({
  default: (await import("@/features/search/global-search-dialog"))
    .GlobalSearchDialog,
}));
const LocalComputerGate = lazy(async () => ({
  default: (await import("@/features/local-computer/local-computer-gate"))
    .LocalComputerGate,
}));
const RoomAddMembersDialog = lazy(async () => ({
  default: (await import("./members/room-add-members-dialog"))
    .RoomAddMembersDialog,
}));

const EMPTY_ROOMS: TeamHubRoomListItem[] = [];

export function RoomShell() {
  const logout = useLogout();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  return <RoomShellReady logout={logout} tenantId={tenantId} />;
}

function RoomShellReady({
  logout,
  tenantId,
}: {
  logout: ReturnType<typeof useLogout>;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const roomsQuery = useQuery(tenantRoomsQueryOptions(client, tenantId));
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const spaceOwnerName = spaceOwnerNameFor(identity, tenantId);
  const anotherMeQuery = useQuery(anotherMeQueryOptions(client, tenantId));
  const anotherMe = anotherMeQuery.data;
  // The Another Me card leads the Room list. Holding the list until both have
  // settled lets them land together, instead of the card arriving later and
  // pushing every row down.
  const navigationPending = roomsQuery.isPending || anotherMeQuery.isPending;
  const gated = anotherMeQuery.isSuccess && !anotherMe?.agent_actor_id;
  const navigate = useNavigate();
  const wasGated = useRef(false);
  const anotherMeRoomId = anotherMe?.room_id;
  // The gate lands the Human in the Another Me Chat it waited for.
  useEffect(() => {
    if (gated) {
      wasGated.current = true;
    } else if (wasGated.current && anotherMeRoomId) {
      wasGated.current = false;
      void navigate(`/t/${tenantId}/rooms/${anotherMeRoomId}/chat`);
    }
  }, [anotherMeRoomId, gated, navigate, tenantId]);

  useEffect(() => {
    document.title = `${spaceOwnerName}'s space`;
  }, [spaceOwnerName]);

  const rooms = roomsQuery.data;
  return (
    <VoiceControlProvider
      key={`${identity.account.id}:${tenantId}`}
      tenantId={tenantId}
    >
      <TeamHubEventSync />
      {/* Voice Mode lives above the Room routes so it survives navigation. */}
      <VoiceModeSessionProvider key={`${identity.account.id}:${tenantId}`}>
        {gated ? (
          <Suspense fallback={null}>
            <LocalComputerGate
              onSignOut={logout.mutate}
              signingOut={logout.isPending}
              tenantId={tenantId}
            />
          </Suspense>
        ) : null}
        <RoomShellContent
          inert={gated}
          logout={logout}
          rooms={
            navigationPending ? EMPTY_ROOMS : (rooms?.items ?? EMPTY_ROOMS)
          }
          navigationStatus={
            navigationPending ? (
              <>
                <span className="sr-only" role="status">
                  Loading Rooms…
                </span>
                <RoomNavigationLoading />
              </>
            ) : roomsQuery.isError ? (
              <div role="alert">
                Rooms could not be loaded.{" "}
                <Button onClick={() => void roomsQuery.refetch()}>
                  Retry Rooms
                </Button>
              </div>
            ) : undefined
          }
          anotherMeActorId={anotherMe?.agent_actor_id}
          anotherMeRoomId={anotherMe?.room_id}
          tenantId={tenantId}
        />
      </VoiceModeSessionProvider>
    </VoiceControlProvider>
  );
}

/** Loads the floating voice window only while a Voice Mode session runs. */
function VoiceModeWindowHost(props: {
  anotherMeActorId?: string;
  currentActorId?: string;
}) {
  if (!useOptionalVoiceModeSession()?.session) return null;
  return (
    <Suspense fallback={null}>
      <VoiceModeMiniWindow {...props} />
    </Suspense>
  );
}

/**
 * Loads the Recording window while it is open or a recording is running,
 * whichever page is showing, so leaving a page never ends a recording. A
 * stopped recording saves in the background without reopening the window.
 */
function RecordingWindowHost() {
  const livekit = useOptionalVoiceControl();
  const { open } = useRecordingWindow();
  const status = livekit?.captureState?.status;
  const running = Boolean(status && !notRunningStatuses.has(status));
  if (!open && !running) return null;
  return (
    <Suspense fallback={null}>
      <RecordingWindow />
    </Suspense>
  );
}

const notRunningStatuses = new Set<string>([
  "idle",
  "completed",
  "failed",
  "finalizing",
  "recovering",
  "permission_blocked",
  "processing",
  "processing_failed",
  "stop_pending",
]);

/** The Profile names the space after the Account's Actor; the rail matches it. */
function spaceOwnerNameFor(identity: TeamHubCurrentIdentity, tenantId: string) {
  return (
    identity.actors.find((actor) => actor.tenant_id === tenantId)
      ?.display_name || identity.account.email
  );
}

function RoomShellContent({
  inert,
  logout,
  anotherMeActorId,
  anotherMeRoomId,
  navigationStatus,
  rooms,
  tenantId,
}: {
  inert: boolean;
  logout: ReturnType<typeof useLogout>;
  anotherMeActorId?: string;
  anotherMeRoomId?: string;
  rooms: TeamHubRoomListItem[];
  navigationStatus?: ReactNode;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  useScrollPaneActivity();
  const newRoomId =
    typeof location.state?.newRoomId === "string" &&
    location.pathname ===
      `/t/${tenantId}/rooms/${location.state.newRoomId}/chat`
      ? (location.state.newRoomId as string)
      : undefined;

  const navigation = useNavigation();
  const { data: tenant } = useSuspenseQuery(
    teamHubTenantQueryOptions(client, tenantId),
  );
  const { data: identity } = useSuspenseQuery(
    teamHubIdentityQueryOptions(client),
  );
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const roomOpen = Boolean(useParams().roomId);
  const openMobileNavigation = useCallback(
    () => setMobileNavigationOpen(true),
    [],
  );
  const desktopShell = isDesktopShell();
  const [frameTitleSlot, setFrameTitleSlot] = useState<HTMLElement | null>(
    null,
  );
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // What a spoken search asked for; the shortcut opens an empty search.
  const [searchQuery, setSearchQuery] = useState("");
  useGlobalSearchShortcut(() => setSearchOpen(true));
  // Voice page actions wait while a route is loading: lazy routes commit
  // their URL only once their code has arrived.
  const navigating = useRef(false);
  useEffect(() => {
    navigating.current = navigation.state !== "idle";
  }, [navigation.state]);
  // Live voice opens rooms, goes back and searches through this shell.
  useEffect(
    () =>
      registerVoiceShell({
        back: () => void navigate(-1),
        navigate: (path) => void navigate(path),
        navigating: () => navigating.current,
        openSearch: (query) => {
          setSearchQuery(query);
          setSearchOpen(true);
        },
      }),
    [navigate],
  );
  const settingsOpen = location.pathname.startsWith(`/t/${tenantId}/settings/`);
  const pendingPathname = navigation.location?.pathname;
  const changingPage =
    navigation.state !== "idle" &&
    Boolean(pendingPathname) &&
    routeLayoutKey(pendingPathname!) !== routeLayoutKey(location.pathname);
  const loadingPathname = changingPage ? pendingPathname! : location.pathname;

  return (
    <ActorAvatarImageProvider identity={identity} tenantId={tenantId}>
      <OpenMobileNavigationContext value={openMobileNavigation}>
        {/* Inside the avatar provider so the window can show Another Me. */}
        <RecordingWindowHost />
        <VoiceModeWindowHost
          anotherMeActorId={anotherMeActorId}
          currentActorId={
            identity.actors.find((actor) => actor.tenant_id === tenantId)?.id
          }
        />
        <div
          className="app-shell flex h-dvh min-h-0 overflow-hidden bg-app-canvas text-app-ink"
          inert={inert}
        >
          <RoomNavigation
            username={spaceOwnerNameFor(identity, tenantId)}
            accountMenu={
              <AccountMenu
                identity={identity}
                tenantId={tenantId}
                isPending={logout.isPending}
                onLogout={logout.mutate}
                onNavigate={() => setMobileNavigationOpen(false)}
                onOpenSettings={() =>
                  void navigate(`/t/${tenantId}/settings/account`)
                }
                settingsOpen={settingsOpen}
              />
            }
            mobileOpen={mobileNavigationOpen}
            onCloseMobile={() => setMobileNavigationOpen(false)}
            onCreateRoom={() => setCreateRoomOpen(true)}
            onOpenSearch={() => setSearchOpen(true)}
            pendingPathname={navigation.location?.pathname}
            rooms={rooms}
            anotherMeRoomId={anotherMeRoomId}
            navigationStatus={navigationStatus}
            tenant={tenant}
          />
          <div className="app-work-surface flex min-w-0 flex-1 flex-col">
            {/* A Room puts this menu button in its own header, so narrow
              screens keep one top bar there. */}
            {roomOpen ? null : (
              <div className="flex h-(--app-header-height) shrink-0 items-center gap-3 border-b border-border/60 bg-app-sidebar px-3 md:hidden">
                <MobileNavigationButton />
                <span className="truncate text-sm font-medium">
                  {spaceOwnerNameFor(identity, tenantId)}'s space
                </span>
              </div>
            )}
            {logout.error ? (
              <div
                className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3 text-sm text-app-danger"
                role="alert"
              >
                <span>{LOGOUT_ERROR_MESSAGE}</span>
                <Button
                  loading={logout.isPending}
                  onClick={logout.mutate}
                  tone="ghost"
                >
                  {logout.isPending ? "Logging out" : "Retry logout"}
                </Button>
              </div>
            ) : null}
            {/* Pages without their own header row put their title in this bar
              on the desktop window frame; Room and Library hide it. */}
            {desktopShell ? (
              <div className="desktop-frame-bar">
                <div className="flex min-w-0 flex-1" ref={setFrameTitleSlot} />
              </div>
            ) : null}
            <div className="app-page-card flex min-h-0 min-w-0 flex-1 flex-col">
              <DesktopBarSlot value={frameTitleSlot}>
                {changingPage ? (
                  <AuthenticatedRouteLoading
                    pathname={loadingPathname}
                    rooms={rooms}
                  />
                ) : (
                  <Suspense
                    fallback={
                      <AuthenticatedRouteLoading
                        pathname={loadingPathname}
                        rooms={rooms}
                      />
                    }
                    key={routeLayoutKey(location.pathname)}
                  >
                    <Outlet />
                  </Suspense>
                )}
              </DesktopBarSlot>
            </div>
          </div>
          {newRoomId ? (
            <Suspense fallback={null}>
              <RoomAddMembersDialog
                key={newRoomId}
                tenantId={tenantId}
                roomId={newRoomId}
                onClose={() => {
                  const state = { ...location.state };
                  delete state.newRoomId;
                  void navigate(location.pathname + location.search, {
                    replace: true,
                    state,
                  });
                }}
              />
            </Suspense>
          ) : null}
          {createRoomOpen ? (
            <Suspense fallback={null}>
              <RoomCreateDialog
                onClose={() => setCreateRoomOpen(false)}
                tenantId={tenantId}
              />
            </Suspense>
          ) : null}
          {searchOpen ? (
            <Suspense fallback={null}>
              <GlobalSearchDialog
                initialQuery={searchQuery}
                onClose={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                tenantId={tenantId}
              />
            </Suspense>
          ) : null}
        </div>
      </OpenMobileNavigationContext>
    </ActorAvatarImageProvider>
  );
}
