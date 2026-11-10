import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  Activity01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  File01Icon,
  Globe02Icon,
  HierarchyIcon,
  InformationCircleIcon,
  Message01Icon,
  PlusSignIcon,
  RoboticIcon,
  Settings01Icon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "../members/actor-avatar";

import type { PanelCreateChoice } from "./panel-create-items";
import { panelCreateItems } from "./panel-create-items";
import type { PanelTab } from "./panel-tab-types";

const kindIcons = {
  agentActivity: Activity01Icon,
  taskActivity: Activity01Icon,
  agentInfo: RoboticIcon,
  file: File01Icon,
  thread: Message01Icon,
  roomSettings: Settings01Icon,
  roomInfo: InformationCircleIcon,
  collaboration: HierarchyIcon,
  url: Globe02Icon,
} as const;

export type { PanelCreateChoice };

export function PanelTabStrip({
  activeTabId,
  launcherOpen,
  includeAgentInfo = false,
  maximized = false,
  onActivate,
  onClose,
  onReorder,
  onCollapse,
  onCreate,
  onToggleMaximize,
  statusByTabId = {},
  tabs,
}: {
  activeTabId: string | null;
  launcherOpen: boolean;
  includeAgentInfo?: boolean;
  maximized?: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder?: (tabId: string, targetId: string) => void;
  onCollapse: () => void;
  onCreate: (choice: PanelCreateChoice) => void;
  onToggleMaximize: () => void;
  statusByTabId?: Record<
    string,
    "running" | "awaitingConfirm" | "failed" | null | undefined
  >;
  tabs: PanelTab[];
}) {
  const { scrollRef, preview, clearDrag, onDragOver, onDrop, onDragStart } =
    usePanelTabDrag({ activeTabId, launcherOpen, onReorder, tabs });
  const resizeLabel = maximized ? "Restore sidebar" : "Maximize sidebar";
  const resizeIcon = maximized ? ArrowShrink01Icon : ArrowExpand01Icon;
  const createItems: ActionMenuItem[] = panelCreateItems(includeAgentInfo).map(
    (item) => {
      return {
        icon: <Icon icon={kindIcons[item.kind] ?? File01Icon} size={14} />,
        label: item.label,
        onSelect: () => onCreate(item.kind),
      };
    },
  );

  if (launcherOpen) {
    return (
      <div
        className="flex h-11 shrink-0 items-center justify-between bg-sidebar px-1"
        data-testid="panel-launcher-toolbar"
      >
        <ActionMenu
          buttonClassName="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          items={createItems}
          label="Add panel view"
          trigger={<Icon icon={PlusSignIcon} size={16} />}
        />

        <div className="flex items-center gap-0.5">
          <button
            aria-label={resizeLabel}
            aria-pressed={maximized}
            className="panel-maximize-control flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onToggleMaximize}
            title={resizeLabel}
            type="button"
          >
            <Icon icon={resizeIcon} size={16} />
          </button>
          <button
            aria-label="Hide sidebar"
            className="flex size-7 items-center justify-center rounded-lg bg-card text-foreground shadow-outline transition-colors hover:bg-muted"
            onClick={onCollapse}
            title="Hide sidebar"
            type="button"
          >
            <SidebarVisibilityIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-11 shrink-0 items-center bg-sidebar"
      data-testid="panel-tab-toolbar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 pl-1">
        {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- composite widget: focus is managed on its child items */}
        <div
          aria-label="Panel tabs"
          className="panel-tab-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
          ref={scrollRef}
          role="tablist"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {tabs.map((tab, index) => {
            let position = index;
            if (preview) {
              if (index === preview.source) position = preview.target;
              else if (
                preview.source < preview.target &&
                index > preview.source &&
                index <= preview.target
              )
                position -= 1;
              else if (
                preview.source > preview.target &&
                index >= preview.target &&
                index < preview.source
              )
                position += 1;
            }
            const isGhost = preview?.source === index;
            const selected = tab.id === activeTabId;
            const tabIcon = kindIcons[tab.kind] ?? File01Icon;
            const status = statusByTabId[tab.id];
            const label = tab.title;
            // The icons identify Agent and Activity tabs; show just the name.
            const visibleLabel =
              tab.kind === "agentInfo"
                ? label.replace(/^Agent · /, "")
                : tab.kind === "agentActivity"
                  ? label.replace(/^Activity · /, "")
                  : label;
            return (
              <div
                className={`panel-tab-item group relative flex h-7 w-[128px] flex-none items-stretch rounded-full motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out ${isGhost ? "outline outline-1 outline-dashed outline-app-focus bg-app-hover [&>button]:opacity-25" : ""} ${
                  selected
                    ? "bg-card text-foreground shadow-outline"
                    : "bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
                key={tab.id}
                data-drag-placeholder={isGhost ? "true" : undefined}
                style={
                  preview
                    ? {
                        transform: `translateX(${preview.positions[position]! - preview.positions[index]!}px)`,
                      }
                    : undefined
                }
              >
                <button
                  aria-label={label}
                  aria-controls={`panel-view-${tab.id}`}
                  aria-selected={selected}
                  draggable={Boolean(onReorder)}
                  title={label}
                  onDragStart={(event) => onDragStart(event, tab, index)}
                  onDragEnd={clearDrag}
                  className="flex min-w-0 flex-1 items-center gap-1 pl-1.5 pr-1 text-left text-xs leading-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-app-focus"
                  data-active={selected ? "true" : undefined}
                  id={`panel-tab-${tab.id}`}
                  onClick={() => onActivate(tab.id)}
                  onKeyDown={(event) => {
                    const currentIndex = tabs.findIndex(
                      (candidate) => candidate.id === tab.id,
                    );
                    if (
                      event.altKey &&
                      event.shiftKey &&
                      (event.key === "ArrowLeft" || event.key === "ArrowRight")
                    ) {
                      const target =
                        tabs[
                          currentIndex + (event.key === "ArrowLeft" ? -1 : 1)
                        ];
                      event.preventDefault();
                      if (target) onReorder?.(tab.id, target.id);
                      return;
                    }
                    const nextIndex =
                      event.key === "ArrowRight"
                        ? (currentIndex + 1) % tabs.length
                        : event.key === "ArrowLeft"
                          ? (currentIndex - 1 + tabs.length) % tabs.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? tabs.length - 1
                              : null;
                    if (nextIndex == null || currentIndex < 0) return;
                    const nextTab = tabs[nextIndex];
                    if (!nextTab) return;
                    event.preventDefault();
                    document.getElementById(`panel-tab-${nextTab.id}`)?.focus();
                    onActivate(nextTab.id);
                  }}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  {tab.kind === "agentInfo" && tab.actorId ? (
                    // An Agent tab shows that Agent's own avatar.
                    <ActorAvatar
                      actorId={tab.actorId}
                      kind="agent"
                      name={visibleLabel}
                      size="micro"
                    />
                  ) : (
                    <Icon className="shrink-0" icon={tabIcon} size={16} />
                  )}
                  {status ? (
                    <span
                      aria-hidden
                      className={`panel-tab-status size-1.5 shrink-0 rounded-full ${
                        status === "failed"
                          ? "bg-app-danger"
                          : status === "awaitingConfirm"
                            ? "bg-app-warning"
                            : "bg-app-success"
                      }`}
                    />
                  ) : null}
                  <span className="panel-tab-title min-w-0 flex-1 truncate font-medium">
                    {visibleLabel}
                  </span>
                  <span
                    aria-hidden="true"
                    className="panel-tab-initial hidden font-medium"
                  >
                    {Array.from(label)[0]}
                  </span>
                </button>
                <button
                  aria-label={`Close ${label}`}
                  className={`panel-tab-close mr-1 flex size-5 shrink-0 self-center items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground ${
                    selected
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                  onClick={() => onClose(tab.id)}
                  type="button"
                >
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <ActionMenu
          buttonClassName="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          items={createItems}
          label="Add panel view"
          trigger={<Icon icon={PlusSignIcon} size={16} />}
        />
      </div>

      <div className="flex shrink-0 items-center justify-center gap-0.5 px-1">
        <button
          aria-label={resizeLabel}
          aria-pressed={maximized}
          className="panel-maximize-control flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onToggleMaximize}
          title={resizeLabel}
          type="button"
        >
          <Icon icon={resizeIcon} size={16} />
        </button>
        <button
          aria-label="Hide sidebar"
          className="flex size-7 items-center justify-center rounded-lg bg-card text-foreground shadow-outline transition-colors hover:bg-muted"
          onClick={onCollapse}
          title="Hide sidebar"
          type="button"
        >
          <SidebarVisibilityIcon />
        </button>
      </div>
    </div>
  );
}

function SidebarVisibilityIcon() {
  return (
    <span aria-hidden="true" className="relative size-4 shrink-0">
      <Icon className="absolute inset-0" icon={SidebarRightIcon} size={16} />
      <span
        className="absolute bottom-[2px] right-[2px] top-[2px] w-1 rounded-r-[1px] bg-current"
        data-testid="sidebar-visibility-fill"
      />
    </span>
  );
}

function usePanelTabDrag({
  activeTabId,
  launcherOpen,
  onReorder,
  tabs,
}: {
  activeTabId: string | null;
  launcherOpen: boolean;
  onReorder?: (tabId: string, targetId: string) => void;
  tabs: PanelTab[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggedTab = useRef<string | null>(null);
  const [preview, setPreview] = useState<{
    source: number;
    target: number;
    positions: number[];
  } | null>(null);
  const dragGeometry = useRef<{
    positions: number[];
    centers: number[];
  } | null>(null);
  const dropIndex = useRef<number | null>(null);
  const clearDrag = () => {
    draggedTab.current = null;
    dragGeometry.current = null;
    dropIndex.current = null;
    setPreview(null);
  };
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? strip.clientWidth
            : 1;
      strip.scrollLeft += delta * scale;
      event.preventDefault();
    };
    strip.addEventListener("wheel", wheel, { passive: false });
    return () => strip.removeEventListener("wheel", wheel);
  }, [launcherOpen]);
  useEffect(() => {
    const strip = scrollRef.current;
    const active = strip?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    )?.parentElement;
    if (!strip || !active) return;
    const bounds = strip.getBoundingClientRect();
    const tabBounds = active.getBoundingClientRect();
    if (tabBounds.left < bounds.left)
      strip.scrollLeft += tabBounds.left - bounds.left;
    else if (tabBounds.right > bounds.right)
      strip.scrollLeft += tabBounds.right - bounds.right;
  }, [activeTabId, launcherOpen]);
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!draggedTab.current || !dragGeometry.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const strip = event.currentTarget;
    const bounds = strip.getBoundingClientRect();
    if (event.clientX < bounds.left + 32) strip.scrollLeft -= 20;
    else if (event.clientX > bounds.right - 32) strip.scrollLeft += 20;
    const x = event.clientX + strip.scrollLeft;
    const centers = dragGeometry.current.centers;
    let target = centers.findIndex((center) => x < center);
    if (target < 0) target = tabs.length - 1;
    else if (target > 0 && x - centers[target - 1]! < centers[target]! - x)
      target -= 1;
    dropIndex.current = target;
    setPreview((current) =>
      current && current.target !== target ? { ...current, target } : current,
    );
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!draggedTab.current) return;
    event.preventDefault();
    const target = tabs[dropIndex.current ?? -1];
    if (target && target.id !== draggedTab.current)
      onReorder?.(draggedTab.current, target.id);
    clearDrag();
  };
  const onDragStart = (
    event: DragEvent<HTMLButtonElement>,
    tab: PanelTab,
    index: number,
  ) => {
    draggedTab.current = tab.id;
    const strip = scrollRef.current!;
    const bounds = Array.from(strip.children).map((child) =>
      child.getBoundingClientRect(),
    );
    const positions = bounds.map((rect) => rect.left + strip.scrollLeft);
    dragGeometry.current = {
      positions,
      centers: bounds.map(
        (rect) => rect.left + rect.width / 2 + strip.scrollLeft,
      ),
    };
    dropIndex.current = index;
    setPreview({ source: index, target: index, positions });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.id);
  };
  return { scrollRef, preview, clearDrag, onDragOver, onDrop, onDragStart };
}
