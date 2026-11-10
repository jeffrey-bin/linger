import { useRoomRenderTiming } from "./room-render-timing";
/* oxlint-disable react-doctor/no-giant-component -- Navigation owns Room grouping, activity state, and the create-Agent flow so these controls share one sidebar lifecycle. */
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  PinIcon,
  Search01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  lazy,
  type MouseEvent,
  type PointerEvent,
  Suspense,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { searchShortcutLabel } from "@/features/search/search-shortcut";
import { markdownPlainText } from "@/features/teamhub/markdown-plain-text";

import { AgentCreateMenu } from "./agent-create-menu";
import type {
  TeamHubRoomListItem,
  TeamHubTenant,
} from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "./members/actor-avatar";
import { useAgentAvatarRecord } from "./members/actor-avatar-image";
import {
  agentAvatarAppearance,
  resolveAgentAvatarKey,
} from "./members/agent-avatar";
import { RoomAvatar } from "./members/room-avatar";
import { PocketNoteLauncher } from "./pocket-notes/pocket-note-launcher";
import { RecordingEntry } from "./voice-control/recording-entry";
import { useNavReorderFlip } from "./use-nav-reorder-flip";

import {
  AgentRowMenu,
  pinnedFirst,
  RoomPinButton,
  useRoomPin,
} from "./room-nav-actions";
const QuickCreateLocalAgentDialog = lazy(async () => ({
  default: (await import("./quick-create-local-agent-dialog"))
    .QuickCreateLocalAgentDialog,
}));
const importCreateAgentFromTemplateFlow = () =>
  import("./agent-templates/create-agent-from-template-flow");
const CreateAgentFromTemplateFlow = lazy(async () => ({
  default: (await importCreateAgentFromTemplateFlow())
    .CreateAgentFromTemplateFlow,
}));

/**
 * Warm the template chunk once the browser is idle. It is lazily loaded to stay
 * off the initial JavaScript graph, so without this the very first open waits on
 * a network fetch behind `fallback={null}` and the dialog snaps in; later opens
 * hit the module cache, which is why this only ever showed up once per session.
 */
function usePrefetchTemplateFlow() {
  useEffect(() => {
    // Idle only, with no timer fallback: a fallback fires inside jsdom, which
    // has no requestIdleCallback, and drags this dynamic import into every test
    // that renders the sidebar. Where the API is missing the dialog simply
    // loads on demand as before.
    const idle = globalThis.requestIdleCallback;
    if (!idle) return;
    // A busy Room may never go idle, so the timeout makes the prefetch happen
    // either way; without it the first open still waits on the fetch.
    const handle = idle(() => void importCreateAgentFromTemplateFlow(), {
      timeout: 2000,
    });
    return () => globalThis.cancelIdleCallback?.(handle);
  }, []);
}

export function RoomSecondaryNavigation({
  activeRoomId,
  anotherMeRoomId,
  navigationStatus,
  onCloseMobile,
  onCollapse,
  onCreateRoom,
  onOpenSearch,
  rooms,
  failedRoomIds = [],
  runningRoomIds = [],
  tenant,
}: {
  activeRoomId?: string;
  anotherMeRoomId?: string;
  navigationStatus?: ReactNode;
  onCloseMobile: () => void;
  /**
   * Given on the desktop app: the header carries the module title and a
   * collapse control, and Search moves into the list.
   */
  onCollapse?: () => void;
  onCreateRoom: () => void;
  onOpenSearch?: () => void;
  rooms: TeamHubRoomListItem[];
  failedRoomIds?: readonly string[];
  runningRoomIds?: readonly string[];
  tenant: TeamHubTenant;
}) {
  usePrefetchTemplateFlow();
  const [localAgentOpen, setLocalAgentOpen] = useState(false);
  const [templateAgentOpen, setTemplateAgentOpen] = useState(false);
  const runningRooms = new Set(runningRoomIds);
  const failedRooms = new Set(failedRoomIds);
  const visibleRoomIds = new Set(
    rooms.flatMap((room) =>
      room.parent_room_id ? [room.parent_room_id] : [room.id],
    ),
  );
  const anotherMeRoom = rooms.find((room) => room.id === anotherMeRoomId);
  const chats = pinnedFirst(
    rooms
      .filter(
        (room) =>
          room.kind === "room" ||
          (room.kind === "direct" &&
            room.id !== anotherMeRoomId &&
            room.direct_peer?.kind === "agent"),
      )
      .sort(
        (left, right) =>
          Date.parse(right.latest_message?.created_at ?? right.created_at) -
          Date.parse(left.latest_message?.created_at ?? left.created_at),
      ),
  );
  const roomPin = useRoomPin(tenant.id);
  function togglePin(room: TeamHubRoomListItem) {
    roomPin.mutate({ pinned: !room.pinned_at, roomId: room.id });
  }
  const visibleAnotherMeRoom =
    anotherMeRoom && visibleRoomIds.has(anotherMeRoom.id)
      ? anotherMeRoom
      : undefined;
  const visibleChats = chats.filter((room) => visibleRoomIds.has(room.id));
  const listRef = useRef<HTMLDivElement>(null);
  const reorderKey = visibleChats
    .map((room) => `${room.id}:${room.pinned_at ? 1 : 0}`)
    .join("|");
  useNavReorderFlip(listRef, reorderKey);
  const navigate = useNavigate();
  function completeNavigation(
    event: MouseEvent<HTMLAnchorElement>,
    roomId: string,
  ) {
    onCloseMobile();
    // A pointer click into another Room means "write here"; keyboard
    // activation, touch, and modified clicks keep the default navigation.
    if (
      event.detail === 0 ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      roomId === activeRoomId ||
      window.matchMedia("(pointer: coarse)").matches
    )
      return;
    event.preventDefault();
    void navigate(`/t/${tenant.id}/rooms/${roomId}/chat`, {
      state: { focusComposer: true },
    });
  }

  const searchButton = (
    <button
      aria-keyshortcuts="Control+k Meta+k"
      aria-label="Search"
      className="room-secondary-navigation-search flex h-7 w-full min-w-0 shrink items-center justify-between gap-1.5 rounded-lg bg-card px-2.5 text-xs text-muted-foreground shadow-outline transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
      onClick={() => {
        onOpenSearch?.();
        onCloseMobile();
      }}
      title={`Search (${searchShortcutLabel()})`}
      type="button"
    >
      <span className="truncate">Search chats</span>
      <Icon className="shrink-0" icon={Search01Icon} size={14} />
    </button>
  );

  return (
    <nav
      aria-label="Room navigation"
      className="app-secondary-navigation relative flex w-[var(--sidebar-width)] min-w-0 flex-col bg-card"
    >
      {onCollapse ? (
        // Shares the 57px height of the chat header so both titles sit on
        // one line; a hairline fades in under it once the list scrolls.
        <header
          aria-label="Message actions"
          className="app-secondary-navigation-header room-secondary-navigation-header relative z-40 flex h-(--app-header-height) shrink-0 items-center justify-between gap-2 pl-px pr-4"
          role="toolbar"
        >
          <span className="room-secondary-navigation-title truncate">
            Messages
          </span>
          <div className="flex items-center gap-0.5">
            <PocketNoteLauncher
              anotherMeRoomId={anotherMeRoomId}
              tenantId={tenant.id}
            />
            <RecordingEntry anotherMeRoomId={anotherMeRoomId} />
          </div>
          <button
            aria-label="Hide Chat list"
            className="room-secondary-navigation-collapse flex size-7 shrink-0 items-center justify-center rounded-md text-app-muted transition-colors hover:bg-app-hover hover:text-app-ink"
            onClick={onCollapse}
            title="Hide Chat list"
            type="button"
          >
            <Icon icon={SidebarLeftIcon} />
          </button>
        </header>
      ) : (
        <div
          className="flex shrink-0 items-center gap-1 pl-0 pr-1.5 pt-3"
          aria-label="Quick access"
        >
          <PocketNoteLauncher
            anotherMeRoomId={anotherMeRoomId}
            tenantId={tenant.id}
          />
          <RecordingEntry anotherMeRoomId={anotherMeRoomId} />
          <button
            aria-keyshortcuts="Control+k Meta+k"
            aria-label="Search"
            title={`Search (${searchShortcutLabel()})`}
            className="xs-nav-search"
            onClick={() => {
              onOpenSearch?.();
              onCloseMobile();
            }}
            type="button"
          >
            <Icon icon={Search01Icon} size={16} />
          </button>
        </div>
      )}

      <div className="room-nav-controls pr-2 md:hidden">
        <div className="mt-1 flex items-center justify-end">
          <Button
            aria-label="Close Room navigation"
            className="md:hidden"
            onClick={onCloseMobile}
            size="icon"
            tone="ghost"
          >
            <Icon icon={Cancel01Icon} size={16} />
          </Button>
        </div>
      </div>

      {localAgentOpen ? (
        <Suspense fallback={null}>
          <QuickCreateLocalAgentDialog
            onClose={() => setLocalAgentOpen(false)}
            tenantId={tenant.id}
          />
        </Suspense>
      ) : null}
      {templateAgentOpen ? (
        <Suspense fallback={null}>
          <CreateAgentFromTemplateFlow
            onClose={() => {
              setTemplateAgentOpen(false);
              onCloseMobile();
            }}
            tenantId={tenant.id}
          />
        </Suspense>
      ) : null}

      <div
        data-voice-scroll="sidebar"
        className="room-secondary-navigation-list workspace-scrollbar flex-1 space-y-3 overflow-y-auto pb-1 pt-2"
        ref={listRef}
      >
        {onCollapse ? searchButton : null}
        {/* While the list loads only its skeleton shows; the card and list
            land together once everything has settled. */}
        {navigationStatus ?? (
          <>
            {visibleAnotherMeRoom ? (
              <AnotherMeCard
                active={visibleAnotherMeRoom.id === activeRoomId}
                failed={failedRooms.has(visibleAnotherMeRoom.id)}
                onNavigate={(event) =>
                  completeNavigation(event, visibleAnotherMeRoom.id)
                }
                room={visibleAnotherMeRoom}
                tenantId={tenant.id}
                working={runningRooms.has(visibleAnotherMeRoom.id)}
              />
            ) : null}
            <NavSection
              action={
                <AgentCreateMenu
                  onCreateFromTemplate={() => setTemplateAgentOpen(true)}
                  onCreateRoom={onCreateRoom}
                  onCreateAgent={() => {
                    setLocalAgentOpen(true);
                    onCloseMobile();
                  }}
                />
              }
              title="Messages"
            >
              {visibleChats.map((room) => {
                if (room.kind === "room")
                  return (
                    <NavRow
                      actions={
                        <RoomPinButton
                          name={room.name}
                          onToggle={() => togglePin(room)}
                          pinned={Boolean(room.pinned_at)}
                        />
                      }
                      active={room.id === activeRoomId}
                      key={room.id}
                    >
                      <Link
                        aria-current={
                          room.id === activeRoomId ? "page" : undefined
                        }
                        aria-label={room.name}
                        className={roomNavClass()}
                        onClick={(event) => completeNavigation(event, room.id)}
                        to={`/t/${tenant.id}/rooms/${room.id}/chat`}
                      >
                        <RoomAvatar members={room.member_preview ?? []} />
                        <span className="min-w-0 flex-1 px-1">
                          <RoomRowTitle pinned={Boolean(room.pinned_at)}>
                            {room.name}
                          </RoomRowTitle>
                          <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
                            {room.latest_message
                              ? markdownPlainText(
                                  room.latest_message.raw_message,
                                )
                              : (room.description ?? "No messages yet")}
                          </span>
                        </span>
                        <RoomRowStatus
                          failed={failedRooms.has(room.id)}
                          room={room}
                          working={runningRooms.has(room.id)}
                        />
                      </Link>
                    </NavRow>
                  );
                const name = room.direct_peer!.display_name;
                return (
                  <NavRow
                    actions={
                      <>
                        <RoomPinButton
                          name={name}
                          onToggle={() => togglePin(room)}
                          pinned={Boolean(room.pinned_at)}
                        />
                        <AgentRowMenu
                          agentId={
                            room.direct_peer_active === false
                              ? undefined
                              : room.direct_peer?.id
                          }
                          name={name}
                          onTogglePin={() => togglePin(room)}
                          pinned={Boolean(room.pinned_at)}
                          tenantId={tenant.id}
                        />
                      </>
                    }
                    active={room.id === activeRoomId}
                    fade="64px"
                    key={room.id}
                  >
                    <DirectRoomLink
                      active={room.id === activeRoomId}
                      onNavigate={(event) => completeNavigation(event, room.id)}
                      room={room}
                      failed={failedRooms.has(room.id)}
                      working={runningRooms.has(room.id)}
                      tenantId={tenant.id}
                    />
                  </NavRow>
                );
              })}
            </NavSection>
          </>
        )}
      </div>
    </nav>
  );
}

function NavSection({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="space-y-1">
      <div
        className={`flex h-7 items-center gap-1 rounded-lg pl-2 ${action ? "pr-0" : "pr-2"}`}
      >
        <h2 className="min-w-0 flex-1">
          <button
            aria-expanded={!collapsed}
            className="flex h-7 w-full min-w-0 items-center gap-1 text-left text-sm leading-[18px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            onClick={() => setCollapsed((value) => !value)}
            type="button"
          >
            <Icon
              className={`size-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
              icon={ArrowDown01Icon}
              size={14}
            />
            <span className="truncate">{title}</span>
          </button>
        </h2>
        {action ? (
          <div className="relative flex shrink-0 items-center">{action}</div>
        ) : null}
      </div>
      {collapsed ? null : <div className="space-y-1">{children}</div>}
    </section>
  );
}

function roomNavClass() {
  return "workspace-nav-row flex min-h-14 items-center gap-2 rounded-lg px-2 py-2 text-foreground";
}

/**
 * The row, not its link, carries the tint, so the title fading out beneath the
 * revealed actions never fades the tint with it.
 */
function NavRow({
  actions,
  active,
  children,
  fade = "36px",
}: {
  actions?: ReactNode;
  active: boolean;
  children: ReactNode;
  fade?: string;
}) {
  return (
    <div
      className={`group rounded-lg ${
        active ? "bg-muted" : "transition-colors duration-300 hover:bg-muted/70"
      }`}
      style={{ "--row-reveal-fade": fade } as CSSProperties}
    >
      {children}
      {actions ? (
        <div className="row-reveal-action flex items-center gap-0.5">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function RoomRowTitle({
  children,
  pinned,
}: {
  children: ReactNode;
  pinned: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm leading-[18px] font-medium text-foreground">
      <span className="min-w-0 truncate">{children}</span>
      {pinned ? (
        <span
          aria-label="Pinned"
          className="room-pin-badge town-pill-pop ml-0.5 flex shrink-0 text-muted-foreground"
          role="img"
        >
          <Icon icon={PinIcon} size={12} />
        </span>
      ) : null}
    </span>
  );
}

function DirectRoomLink({
  active,
  failed,
  working,
  onNavigate,
  room,
  tenantId,
}: {
  active: boolean;
  failed?: boolean;
  working: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
  room: TeamHubRoomListItem;
  tenantId: string;
}) {
  const peer = room.direct_peer!;
  const displayName = peer.display_name;
  const inactive = room.direct_peer_active === false;
  const [hovered, setHovered] = useState(false);
  return (
    <Link
      aria-current={active ? "page" : undefined}
      aria-label={`${displayName}${inactive ? ", Deleted" : ""}`}
      className={roomNavClass()}
      onClick={onNavigate}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      to={`/t/${tenantId}/rooms/${room.id}/chat`}
    >
      <ActorAvatar
        actorId={peer.id}
        animate={!inactive && (hovered || working)}
        kind={peer.kind}
        name={displayName}
        size="nav"
      />
      <span className="min-w-0 flex-1 px-1">
        <RoomRowTitle pinned={Boolean(room.pinned_at)}>
          {displayName}
        </RoomRowTitle>
        <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
          {inactive
            ? "Deleted"
            : room.latest_message
              ? markdownPlainText(room.latest_message.raw_message)
              : "No messages yet"}
        </span>
      </span>
      <RoomRowStatus failed={failed} room={room} working={working} />
    </Link>
  );
}

function RoomAttentionBadge({ room }: { room: TeamHubRoomListItem }) {
  if (room.unread_message_count === 0 && room.unread_mention_count === 0) {
    return null;
  }

  const mentions = room.unread_mention_count > 0;
  const count = mentions
    ? room.unread_mention_count
    : room.unread_message_count;
  const label = mentions
    ? `${count} unread mention${count === 1 ? "" : "s"}`
    : `${count} unread message${count === 1 ? "" : "s"}`;

  return (
    <span
      aria-label={label}
      className="town-pill-pop inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--app-unread) px-1 text-2xs leading-none font-medium text-(--app-unread-foreground)"
      title={label}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Another Me is pinned above the lists as the Human's own card. Its actions
 * live in the toolbar above the card.
 * The card takes its colour from the Agent's avatar background: a glow of it
 * follows the pointer, and the open card fills with it.
 */
function AnotherMeCard({
  active,
  failed,
  onNavigate,
  room,
  tenantId,
  working,
}: {
  active: boolean;
  failed: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
  room: TeamHubRoomListItem;
  tenantId: string;
  working: boolean;
}) {
  const name = room.direct_peer?.display_name ?? "Another Me";
  const agentRecord = useAgentAvatarRecord(room.direct_peer?.id);
  const brand = agentAvatarAppearance(
    resolveAgentAvatarKey({
      actorId: room.direct_peer?.id,
      name,
      storedKey: agentRecord?.avatarKey,
    }),
  ).color;
  // Avatar backgrounds are user-selectable, including white and pale figures.
  const luminance = [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel =
      parseInt(brand.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return (
      sum +
      weight *
        (channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
  const darkText = luminance > 0.179;
  // Dark text is the ink #1a1a16, whose relative luminance is about 0.0097.
  const contrast = darkText
    ? (luminance + 0.05) / 0.0597
    : 1.05 / (luminance + 0.05);
  const [hovered, setHovered] = useState(false);
  const tiltFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(tiltFrame.current), []);
  function tilt(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = requestAnimationFrame(() => {
      card.style.setProperty(
        "--am-tilt-x",
        `${((0.5 - y) * 18).toFixed(2)}deg`,
      );
      card.style.setProperty(
        "--am-tilt-y",
        `${((x - 0.5) * 16).toFixed(2)}deg`,
      );
      card.style.setProperty("--am-glow-x", `${x * 100}%`);
      card.style.setProperty("--am-glow-y", `${y * 100}%`);
    });
  }
  function settle(event: PointerEvent<HTMLDivElement>) {
    cancelAnimationFrame(tiltFrame.current);
    for (const property of [
      "--am-tilt-x",
      "--am-tilt-y",
      "--am-glow-x",
      "--am-glow-y",
    ]) {
      event.currentTarget.style.removeProperty(property);
    }
  }
  return (
    <div
      className="another-me-card"
      data-active={active ? "true" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        settle(event);
      }}
      onPointerMove={tilt}
      style={
        {
          "--am-brand": brand,
          "--am-text": darkText ? "#1a1a16" : "#fff",
          "--am-sub-opacity": contrast >= 7 ? 0.82 : 1,
        } as CSSProperties
      }
    >
      <Link
        aria-current={active ? "page" : undefined}
        aria-label="Another Me Chat"
        className="workspace-nav-row another-me-card-link flex text-app-ink"
        onClick={onNavigate}
        to={`/t/${tenantId}/rooms/${room.id}/chat`}
      >
        <span className="another-me-card-avatar shrink-0">
          <ActorAvatar
            actorId={room.direct_peer?.id}
            animate={hovered || working}
            kind="agent"
            name={name}
            size="card"
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="another-me-card-title block truncate text-sm leading-[18px] font-medium text-app-ink">
            {name}
          </span>
          <span className="another-me-card-sub mt-0.5 block truncate text-xs leading-4 text-app-muted">
            {room.latest_message
              ? markdownPlainText(room.latest_message.raw_message)
              : "Your personal agent"}
          </span>
        </span>
        <RoomRowStatus failed={failed} room={room} working={working} />
      </Link>
    </div>
  );
}

function RoomRowStatus({
  failed = false,
  room,
  working,
}: {
  failed?: boolean;
  room: TeamHubRoomListItem;
  working: boolean;
}) {
  useRoomRenderTiming("room_list", {
    roomId: room.id,
    result: working ? "working" : "stopped",
  });
  return (
    <span className="row-reveal-hide ml-auto flex shrink-0 items-center gap-1.5">
      <RoomAttentionBadge room={room} />
      <span className="flex size-4 shrink-0 items-center justify-center">
        {working ? (
          <svg
            aria-label="Agent working"
            className="size-3.5 animate-spin text-app-muted motion-reduce:animate-none"
            fill="none"
            role="img"
            viewBox="0 0 16 16"
          >
            <title>Agent working</title>
            <circle
              cx="8"
              cy="8"
              r="5.75"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth="1.5"
            />
            <path
              d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.5"
            />
          </svg>
        ) : failed ? (
          <span
            aria-label="Last run failed"
            className="flex text-app-danger"
            role="img"
          >
            <Icon icon={AlertCircleIcon} size={14} />
          </span>
        ) : null}
      </span>
    </span>
  );
}
