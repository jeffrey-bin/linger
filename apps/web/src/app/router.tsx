/* oxlint-disable react-doctor/only-export-components -- Route factories and route surfaces share one app-owned interface. */
import type { QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import {
  redirect,
  type RouteObject,
  type LoaderFunction,
  useNavigate,
  useParams,
  useRouteError,
} from "react-router";

import { authenticationOperation } from "@/features/auth/authentication-operation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  OAUTH_COMPLETE_PATH,
  OAuthCompletePage,
} from "@/features/apps/oauth-complete-page";
import { authenticatedLoginDestination } from "@/features/auth/authentication-return-to";
import {
  anotherMeQueryOptions,
  clearTeamHubQueries,
  roomMembersQueryOptions,
  roomMessagesInfiniteQueryOptions,
  roomQueryKey,
  roomQueryOptions,
  teamHubIdentityQueryOptions,
  teamHubSessionQueryOptions,
  teamHubTenantQueryOptions,
  teamHubTenantsQueryOptions,
  tenantRoomsQueryOptions,
  tenantAgentsQueryOptions,
} from "@/features/rooms/room-queries";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { RoomShell } from "@/features/rooms/room-shell";
import { RoomSurface } from "@/features/rooms/room-surface";
import { routeLayoutKey } from "@/features/rooms/route-layout-key";
import { RoomChatLoading } from "@/features/rooms/route-loading-surface";
import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import {
  tenantWorkItemTargetQueryOptions,
  tenantWorkItemsDashboardQueryOptions,
} from "@/features/work-items/work-item-queries";

import {
  FullPageRouteErrorSurface,
  PanelRouteErrorSurface,
} from "./route-error-surfaces";

export function createAppRoutes(
  queryClient: QueryClient,
  runtime: TeamHubRuntime,
): RouteObject[] {
  const { client } = runtime;
  const loadRoomBootstrap = createRoomBootstrapLoader(queryClient, client);

  return [
    {
      element: <InitialAppLoading />,
      ErrorBoundary: FullPageRouteErrorSurface,
      HydrateFallback: InitialAppLoading,
      loader: withAuthenticationDeadline(async ({ request }) => {
        try {
          await queryClient.ensureQueryData(teamHubSessionQueryOptions(client));
          const tenants = await queryClient.ensureQueryData(
            teamHubTenantsQueryOptions(client),
          );
          const tenant = tenants.items[0];

          if (!tenant) {
            throw new Error("This Account has no Space.");
          }

          const roomId = await landingRoomId(queryClient, client, tenant.id);

          throw redirect(
            roomId
              ? `/t/${tenant.id}/rooms/${roomId}/chat`
              : `/t/${tenant.id}/rooms`,
          );
        } catch (error) {
          request.signal.throwIfAborted();
          redirectAuthenticationError(error, queryClient);
          throw error;
        }
      }),
      path: "/",
    },
    {
      lazy: () =>
        authenticationOperation(new AbortController().signal, async () => ({
          Component: (await import("@/features/auth/teamhub-login-page"))
            .TeamHubLoginPage,
        })),
      ErrorBoundary: FullPageRouteErrorSurface,
      HydrateFallback: InitialAppLoading,
      loader: withAuthenticationDeadline(async ({ request }) => {
        // Signed-in users visiting the login page go straight to the product entry; the session check always asks the server,
        // so a cache left over after sign-out cannot send the user back to a protected page.
        try {
          await queryClient.fetchQuery({
            ...teamHubSessionQueryOptions(client),
            staleTime: 0,
          });
        } catch {
          // When signed out or the session is unavailable, keep the login page and let the login flow handle it.
          return null;
        }
        throw redirect(
          authenticatedLoginDestination(new URL(request.url).searchParams),
        );
      }),
      path: "/login",
    },
    { lazy: loadSharedDocumentPage, path: "/shared-documents" },
    {
      path: "/shared-room-history",
      lazy: async () => {
        const { SharedRoomHistoryPage } =
          await import("@/features/rooms/sharing/shared-room-history-page");
        return { Component: SharedRoomHistoryPage };
      },
    },
    {
      element: <OAuthCompletePage />,
      path: OAUTH_COMPLETE_PATH,
    },
    {
      ErrorBoundary: FullPageRouteErrorSurface,
      lazy: () =>
        authenticationOperation(
          new AbortController().signal,
          loadConnectComputerPage,
        ),
      loader: withAuthenticationDeadline(async ({ request }) => {
        try {
          await Promise.all([
            queryClient.ensureQueryData(teamHubSessionQueryOptions(client)),
            queryClient.ensureQueryData(teamHubTenantsQueryOptions(client)),
          ]);
          return null;
        } catch (error) {
          request.signal.throwIfAborted();
          const current = new URL(request.url);
          const returnTo = `${current.pathname}${current.search}`;
          redirectAuthenticationError(
            error,
            queryClient,
            `/login?return_to=${encodeURIComponent(returnTo)}`,
          );
          throw error;
        }
      }),
      path: "/connect-computer",
    },
    {
      children: [
        {
          lazy: () =>
            authenticationOperation(new AbortController().signal, async () => ({
              Component: (await import("@/features/rooms/room-empty-page"))
                .RoomEmptyPage,
            })),
          ErrorBoundary: PanelRouteErrorSurface,
          loader: withAuthenticationDeadline(async ({ params, request }) => {
            const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
            const roomId = await landingRoomId(queryClient, client, tenantId);

            if (roomId) {
              // Carries an opened Settings section into the Room behind it.
              throw redirect(
                `/t/${tenantId}/rooms/${roomId}/chat${new URL(request.url).search}`,
              );
            }

            return null;
          }),
          path: "rooms",
        },
        {
          element: <RoomSurface />,
          errorElement: <RoomRouteErrorSurface queryClient={queryClient} />,
          loader: ({ params }) => {
            const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
            const roomId = requireRoomRouteParam(params.roomId, "Room");
            // Direct-room composers need this directory. Start it alongside
            // the authoritative Room requests without making it a route gate.
            void queryClient.prefetchQuery(
              tenantAgentsQueryOptions(client, tenantId),
            );
            // Capture only a complete, successful destination cache. The
            // authoritative bootstrap still runs before Room event catch-up.
            const cachedMessages = queryClient.getQueryData(
              roomMessagesInfiniteQueryOptions(client, tenantId, roomId)
                .queryKey,
            );
            const cachedProjection = [
              roomMessagesInfiniteQueryOptions(client, tenantId, roomId)
                .queryKey,
              roomQueryOptions(client, tenantId, roomId).queryKey,
              roomMembersQueryOptions(client, tenantId, roomId).queryKey,
            ].every((queryKey) => {
              const state = queryClient.getQueryState(queryKey);
              return state?.status === "success" && !state.isInvalidated;
            });
            return {
              initialRoomSeq: cachedProjection
                ? cachedMessages?.pages[0]?.snapshot_room_seq
                : undefined,
              ...loadRoomBootstrap(tenantId, roomId),
            };
          },
          path: "rooms/:roomId",
          shouldRevalidate: ({
            currentUrl,
            defaultShouldRevalidate,
            nextUrl,
          }) =>
            routeLayoutKey(currentUrl.pathname) ===
            routeLayoutKey(nextUrl.pathname)
              ? false
              : defaultShouldRevalidate,
          children: [
            {
              loader: ({ params }) => {
                const tenantId = requireRoomRouteParam(
                  params.tenantId,
                  "Tenant",
                );
                const roomId = requireRoomRouteParam(params.roomId, "Room");
                throw redirect(`/t/${tenantId}/rooms/${roomId}/chat`);
              },
              index: true,
            },
            {
              ErrorBoundary: PanelRouteErrorSurface,
              element: (
                <Suspense fallback={<RoomChatLoading />}>
                  <LazyRoomChat />
                </Suspense>
              ),
              path: "chat",
            },
          ],
        },
        {
          ErrorBoundary: PanelRouteErrorSurface,
          loader: ({ params }) => {
            const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
            throw redirect(`/t/${tenantId}/settings/account`);
          },
          path: "profile",
        },
        createWorkItemDashboardRoute(
          queryClient,
          client,
          "dashboard/:workItemId",
        ),
        createWorkspaceRoute(),
        {
          ErrorBoundary: PanelRouteErrorSurface,
          lazy: loadConnectedAppsPage,
          path: "apps",
        },
        {
          path: "computers",
          loader: ({ params, request }) =>
            redirect(
              `/t/${params.tenantId}/settings/computers${new URL(request.url).search}`,
            ),
        },
        createSettingsRoute(),
        {
          // Unknown Space paths keep the rail, so the reader can still navigate.
          element: <NotFoundRoute inShell />,
          path: "*",
        },
      ],
      element: <RoomShell />,
      ErrorBoundary: FullPageRouteErrorSurface,
      HydrateFallback: InitialAppLoading,
      loader: withAuthenticationDeadline(async ({ params, request }) => {
        const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");

        // Sidebar data starts alongside authorization but cannot gate the Room.
        void queryClient.prefetchQuery(
          tenantRoomsQueryOptions(client, tenantId),
        );

        try {
          await Promise.all([
            queryClient.ensureQueryData(teamHubSessionQueryOptions(client)),
            queryClient.ensureQueryData(teamHubIdentityQueryOptions(client)),
            queryClient.ensureQueryData(
              teamHubTenantQueryOptions(client, tenantId),
            ),
          ]);
        } catch (error) {
          request.signal.throwIfAborted();
          redirectAuthenticationError(error, queryClient);
          throw error;
        }

        return null;
      }),
      path: "/t/:tenantId",
    },
    {
      element: <NotFoundRoute />,
      path: "*",
    },
  ];
}

function createWorkItemDashboardRoute(
  queryClient: QueryClient,
  client: TeamHubClient,
  path: "dashboard/:workItemId",
): RouteObject {
  return {
    ErrorBoundary: PanelRouteErrorSurface,
    lazy: async () => {
      const { WorkItemsPage } =
        await import("@/features/work-items/work-items-page");
      return { Component: WorkItemsPage };
    },
    loader: ({ params }) => {
      const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
      void queryClient.prefetchQuery(tenantRoomsQueryOptions(client, tenantId));
      void queryClient.prefetchQuery(
        tenantWorkItemsDashboardQueryOptions(client, tenantId),
      );
      if (params.workItemId) {
        void queryClient.prefetchQuery(
          tenantWorkItemTargetQueryOptions(client, tenantId, params.workItemId),
        );
      }
      return null;
    },
    path,
  };
}

async function loadConnectComputerPage() {
  const { ConnectComputerPage } =
    await import("@/features/local-computer/connect-computer-page");
  return { Component: ConnectComputerPage };
}

async function loadSharedDocumentPage() {
  const { SharedDocumentPage } =
    await import("@/features/rooms/documents/shared-document-page");
  return { Component: SharedDocumentPage };
}

async function loadLibraryLayout() {
  const { LibraryLayout } = await import("@/features/library/library-layout");
  return { Component: LibraryLayout };
}

async function loadLibraryDocumentsPage() {
  const { LibraryDocumentsPage } =
    await import("@/features/library/library-documents-page");
  return { Component: LibraryDocumentsPage };
}

async function loadWikiPreviewPage() {
  const { WikiPreviewPage } = await import("@/features/wiki/wiki-preview-page");
  return { Component: WikiPreviewPage };
}

async function loadWikiCollectionPage() {
  const { WikiCollectionPage } =
    await import("@/features/wiki/wiki-collection-page");
  return { Component: WikiCollectionPage };
}

async function loadMeetingPage() {
  const { MeetingPage } = await import("@/features/memory/meeting-page");
  return { Component: MeetingPage };
}

const LazyRoomChat = lazy(async () => ({
  default: (await import("@/features/rooms/chat/room-chat")).RoomChat,
}));

interface RoomBootstrapData {
  initialRoomSeq: number;
}
type RoomBootstrapLoader = (
  tenantId: string,
  roomId: string,
) => RoomBootstrapTask;
interface RoomBootstrapTask {
  presentation: Promise<RoomBootstrapData>;
  bootstrap: Promise<RoomBootstrapData>;
}

// Surface authorization failures immediately, then purge once more after all
// parallel reads settle: a late sibling must never refill a denied Room cache.
function clearDeniedRoomCache(
  error: unknown,
  queryClient: QueryClient,
  tenantId: string | undefined,
  roomId: string | undefined,
) {
  if (!(error instanceof TeamHubError)) return;
  if (error.status === 401) {
    clearTeamHubQueries(queryClient);
  } else if (
    tenantId &&
    roomId &&
    (error.status === 403 || error.status === 404)
  ) {
    queryClient.removeQueries({ queryKey: roomQueryKey(tenantId, roomId) });
  }
}

function clearDenialAfterSettlement(
  tasks: readonly Promise<unknown>[],
  queryClient: QueryClient,
  tenantId: string,
  roomId: string,
) {
  void Promise.allSettled(tasks).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        clearDeniedRoomCache(result.reason, queryClient, tenantId, roomId);
      }
    }
  });
}

// The cached Room subtree can still have active query observers when the
// bootstrap rejects. Purge again after its error boundary has replaced it,
// otherwise a pending observer may refill the denied Room cache in the gap.
function RoomRouteErrorSurface({ queryClient }: { queryClient: QueryClient }) {
  const { tenantId, roomId } = useParams();
  const error = useRouteError();
  useEffect(() => {
    clearDeniedRoomCache(error, queryClient, tenantId, roomId);
  }, [error, queryClient, roomId, tenantId]);
  return <PanelRouteErrorSurface />;
}

function createRoomBootstrapLoader(
  queryClient: QueryClient,
  client: TeamHubClient,
): RoomBootstrapLoader {
  const pending = new Map<string, RoomBootstrapTask>();

  return (tenantId, roomId) => {
    const key = JSON.stringify([tenantId, roomId]);
    const existing = pending.get(key);
    if (existing) {
      return existing;
    }

    const task = loadRoomBootstrapProjection(
      queryClient,
      client,
      tenantId,
      roomId,
    );
    const handleError = (error: unknown) => {
      clearDeniedRoomCache(error, queryClient, tenantId, roomId);
      throw error;
    };
    const result = {
      presentation: task.presentation.catch(handleError),
      bootstrap: task.bootstrap.catch(handleError),
    };
    pending.set(key, result);
    const clear = () => {
      if (pending.get(key) === result) {
        pending.delete(key);
      }
    };
    // Either stage may outlive its route (cached or abandoned navigation).
    // Keep the rejection observable to Await without leaking an unhandled promise.
    void result.presentation.then(
      () => {},
      () => {},
    );
    void result.bootstrap.then(clear, clear);
    return result;
  };
}

function loadRoomBootstrapProjection(
  queryClient: QueryClient,
  client: TeamHubClient,
  tenantId: string,
  roomId: string,
): RoomBootstrapTask {
  const room = roomQueryOptions(client, tenantId, roomId);
  const members = roomMembersQueryOptions(client, tenantId, roomId);
  const messages = queryClient.ensureInfiniteQueryData(
    roomMessagesInfiniteQueryOptions(client, tenantId, roomId),
  );
  const authorization = Promise.all([
    queryClient.cancelQueries({ exact: true, queryKey: room.queryKey }),
    queryClient.cancelQueries({ exact: true, queryKey: members.queryKey }),
  ]).then(() => {
    const roomRefresh = queryClient.fetchQuery({ ...room, staleTime: 0 });
    const membersRefresh = queryClient.fetchQuery({ ...members, staleTime: 0 });
    clearDenialAfterSettlement(
      [messages, roomRefresh, membersRefresh],
      queryClient,
      tenantId,
      roomId,
    );
    return Promise.all([roomRefresh, membersRefresh]);
  });
  const firstPass = Promise.all([messages, authorization]).then(
    ([history, [roomSnapshot, membersSnapshot]]) => {
      const initialRoomSeq = history.pages[0]?.snapshot_room_seq ?? 0;
      return {
        initialRoomSeq,
        refreshRoom:
          roomSnapshot.snapshot_room_seq === undefined ||
          roomSnapshot.snapshot_room_seq < initialRoomSeq,
        refreshMembers:
          membersSnapshot.snapshot_room_seq === undefined ||
          membersSnapshot.snapshot_room_seq < initialRoomSeq,
      };
    },
  );
  const presentation = firstPass;
  // Refresh Room projections older than the Message watermark before realtime starts.
  const bootstrap = presentation.then(async (ready) => {
    // These are individually typed query options; the heterogeneous array
    // cannot retain each query key's data tag in TypeScript.
    const reads = [
      ...(ready.refreshRoom ? [room] : []),
      ...(ready.refreshMembers ? [members] : []),
    ].map((options) =>
      queryClient.fetchQuery({ ...options, staleTime: 0 } as Parameters<
        typeof queryClient.fetchQuery
      >[0]),
    );
    clearDenialAfterSettlement(reads, queryClient, tenantId, roomId);
    await Promise.all(reads);
    return ready;
  });
  return {
    presentation,
    bootstrap,
  };
}

/**
 * The Room a Space opens on: the Human's Another Me Chat, where onboarding
 * starts, else the first Room. The starter Rooms share the Chat's creation
 * time, so list order alone would pick one of them by ID. The Room shell reads
 * the Another Me too, so this adds no request; a failed read only drops the
 * preference.
 */
async function landingRoomId(
  queryClient: QueryClient,
  client: TeamHubClient,
  tenantId: string,
): Promise<string | undefined> {
  const [rooms, anotherMe] = await Promise.all([
    queryClient.ensureQueryData(tenantRoomsQueryOptions(client, tenantId)),
    queryClient
      .ensureQueryData(anotherMeQueryOptions(client, tenantId))
      .catch(() => undefined),
  ]);
  const preferred = anotherMe?.room_id;
  return preferred && rooms.items.some((room) => room.id === preferred)
    ? preferred
    : rooms.items[0]?.id;
}

/**
 * Library pages and opened Documents share one Workspace layout, so its
 * sidebar stays mounted while only the content beside it changes.
 */
function createWorkspaceRoute(): RouteObject {
  return {
    children: [
      createLibraryRoute(),
      {
        ErrorBoundary: PanelRouteErrorSurface,
        lazy: loadUnifiedDocumentPage,
        path: "documents/:documentId",
      },
      {
        // A Wiki page the running refresh has written but not published.
        ErrorBoundary: PanelRouteErrorSurface,
        lazy: loadWikiPreviewPage,
        path: "wiki-preview",
      },
    ],
    lazy: loadLibraryLayout,
  };
}

function createLibraryRoute(): RouteObject {
  return {
    children: [
      {
        index: true,
        lazy: loadLibraryDocumentsPage,
      },
      {
        loader: ({ params, request }) => {
          const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
          throw redirect(
            `/t/${tenantId}/library${new URL(request.url).search}`,
          );
        },
        path: "my-documents",
      },
      {
        loader: ({ params, request }) => {
          const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
          throw redirect(
            `/t/${tenantId}/library${new URL(request.url).search}`,
          );
        },
        path: "shared-with-me",
      },
      {
        loader: ({ params, request }) => {
          const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
          throw redirect(
            `/t/${tenantId}/library${new URL(request.url).search}`,
          );
        },
        path: "documents",
      },
      {
        ErrorBoundary: PanelRouteErrorSurface,
        lazy: loadWikiCollectionPage,
        path: "wiki/:collection?",
      },
      {
        // One meeting opens by `entry`; the list is the Workspace Meetings tab.
        ErrorBoundary: PanelRouteErrorSurface,
        lazy: loadMeetingPage,
        loader: ({ params, request }) => {
          if (new URL(request.url).searchParams.get("entry")) return null;
          const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
          throw redirect(`/t/${tenantId}/library?tab=meetings`);
        },
        path: "meetings",
      },
    ],
    path: "library",
  };
}

async function loadUnifiedDocumentPage() {
  const { preloadUnifiedDocumentPage } =
    await import("@/features/rooms/documents/document-route-preload");
  const { UnifiedDocumentPage } = await preloadUnifiedDocumentPage();
  return { Component: UnifiedDocumentPage };
}

async function loadConnectedAppsPage() {
  const { ConnectedAppsPage } =
    await import("@/features/apps/connected-apps-page");
  return { Component: ConnectedAppsPage };
}

/** Settings is a page in the Space shell; each section owns its address. */
function createSettingsRoute(): RouteObject {
  function openProfile({
    params,
    request,
  }: {
    params: { tenantId?: string };
    request: Request;
  }): never {
    const tenantId = requireRoomRouteParam(params.tenantId, "Tenant");
    throw redirect(
      `/t/${tenantId}/settings/account${new URL(request.url).search}`,
    );
  }

  return {
    children: [
      { index: true, loader: openProfile },
      {
        lazy: async () => ({
          Component: (await import("@/features/settings/account-settings-page"))
            .AccountSettingsPage,
        }),
        path: "account",
      },
      {
        lazy: async () => ({
          Component: (
            await import("@/features/settings/security-settings-page")
          ).SecuritySettingsPage,
        }),
        path: "security",
      },
      {
        lazy: async () => ({
          Component: (await import("@/features/local-computer/computers-page"))
            .ComputersPage,
        }),
        path: "computers",
      },
      { loader: openProfile, path: "administration" },
    ],
    ErrorBoundary: PanelRouteErrorSurface,
    // Settings is reachable from every surface, so it stays out of the shell
    // bundle until opened.
    lazy: async () => ({
      Component: (await import("@/features/settings/settings-page"))
        .SettingsLayout,
    }),
    path: "settings",
  };
}

export function InitialAppLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading TeamHub"
      className="flex min-h-dvh items-center justify-center gap-2 bg-app-canvas text-sm text-app-muted"
    >
      <Spinner />
      Loading Room...
    </main>
  );
}

function redirectAuthenticationError(
  error: unknown,
  queryClient: QueryClient,
  loginPath = "/login",
): never | void {
  if (error instanceof TeamHubError && error.status === 401) {
    clearTeamHubQueries(queryClient);
    throw redirect(loginPath);
  }
}

function NotFoundRoute({ inShell = false }: { inShell?: boolean }) {
  const navigate = useNavigate();
  const { tenantId } = useParams();

  return (
    <main
      className={`flex flex-col items-center justify-center gap-4 bg-app-canvas px-8 text-center text-app-ink ${inShell ? "h-full min-h-0 flex-1" : "min-h-dvh"}`}
    >
      <h1 className="text-lg">Page not found</h1>
      <Button
        onClick={() => {
          void navigate(tenantId ? `/t/${tenantId}/rooms` : "/");
        }}
      >
        Open Message
      </Button>
    </main>
  );
}

// Route failures commit the destination's retry surface instead of retaining
// an indefinitely pending login navigation. Late loader results are discarded.
function withAuthenticationDeadline(loader: LoaderFunction): LoaderFunction {
  return (args) =>
    authenticationOperation(args.request.signal, async (signal) =>
      loader({
        ...args,
        request: new Request(args.request, { signal }),
      }),
    );
}
