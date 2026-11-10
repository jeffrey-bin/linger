import {
  ArrowRight01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/ui/icon";

export type MenuPlacement =
  | "bottom-end"
  | "bottom-start"
  | "right-start"
  | "top-start";

export interface ActionMenuItem {
  children?: ActionMenuItem[];
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  onSelect?: () => void;
  separatorBefore?: boolean;
}

export function ActionMenu({
  buttonClassName = "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  header,
  followAnchor = false,
  openOnHover = false,
  onTriggerClick,
  initialFocusIndex = 0,
  placement = "bottom-end",
  iconClassName = "flex size-4 shrink-0 items-center justify-center",
  itemClassName = "flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50",
  items,
  label,
  menuClassName = "app-popover-card fixed z-[100] w-[232px] p-1",
  trigger = <Icon icon={MoreHorizontalIcon} size={16} />,
}: {
  buttonClassName?: string;
  header?: ReactNode;
  followAnchor?: boolean;
  openOnHover?: boolean;
  onTriggerClick?: () => void;
  initialFocusIndex?: number;
  placement?: MenuPlacement;
  iconClassName?: string;
  itemClassName?: string;
  items: ActionMenuItem[];
  label: string;
  menuClassName?: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState(true);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [activeSubmenu, setActiveSubmenu] = useState<number | null>(null);
  const [submenuSide, setSubmenuSide] = useState<"left" | "right">("right");
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [menuSide, setMenuSide] = useState<"bottom" | "right" | "top">(
    "bottom",
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function cancelHoverClose() {
    clearTimeout(hoverCloseTimer.current);
  }
  function scheduleHoverClose() {
    if (!openOnHover) return;
    cancelHoverClose();
    hoverCloseTimer.current = setTimeout(() => {
      if (!menuRef.current?.contains(document.activeElement)) setOpen(false);
    }, 150);
  }
  useEffect(() => () => clearTimeout(hoverCloseTimer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) return;
      const next = computeMenuPosition(
        triggerRect,
        menuRef.current?.getBoundingClientRect(),
        placement,
      );
      setPosition(next);
      setMenuSide(
        placement === "right-start"
          ? "right"
          : next.top < triggerRect.top
            ? "top"
            : "bottom",
      );
    };
    updatePosition();
    if (!followAnchor) return;
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updatePosition);
    if (menuRef.current) observer?.observe(menuRef.current);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      observer?.disconnect();
    };
  }, [open, placement, followAnchor]);

  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const frame = requestAnimationFrame(() => {
      const preferred = itemRefs.current[initialFocusIndex];
      const target =
        preferred && !preferred.disabled
          ? preferred
          : itemRefs.current.find((item) => item && !item.disabled);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusOnOpen, initialFocusIndex]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target) &&
        !submenuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnViewportLayoutChange = (event?: Event) => {
      if (followAnchor) return;
      if (event?.type === "scroll" && !isViewportScrollTarget(event.target)) {
        return;
      }
      setOpen(false);
    };
    const closeHoverOnEscape = (event: globalThis.KeyboardEvent) => {
      if (
        openOnHover &&
        event.key === "Escape" &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        event.preventDefault();
        setActiveSubmenu(null);
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeHoverOnEscape);
    window.addEventListener("resize", closeOnViewportLayoutChange);
    window.addEventListener("scroll", closeOnViewportLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeHoverOnEscape);
      window.removeEventListener("resize", closeOnViewportLayoutChange);
      window.removeEventListener("scroll", closeOnViewportLayoutChange, true);
    };
  }, [open, followAnchor, openOnHover]);

  function closeMenu() {
    setActiveSubmenu(null);
    setOpen(false);
  }

  function openSubmenu(index: number) {
    const menuRect = menuRef.current?.getBoundingClientRect();
    setSubmenuSide(
      menuRect && menuRect.right + 184 > window.innerWidth ? "left" : "right",
    );
    setActiveSubmenu(index);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const enabled = itemRefs.current.filter((item): item is HTMLButtonElement =>
      Boolean(item && !item.disabled),
    );
    const current = enabled.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next = (current + direction + enabled.length) % enabled.length;
    enabled[next]?.focus();
  }

  const submenuItems =
    activeSubmenu === null ? undefined : items[activeSubmenu]?.children;

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={buttonClassName}
        onPointerEnter={(event) => {
          if (!openOnHover || event.pointerType === "touch") return;
          cancelHoverClose();
          if (!open) {
            setFocusOnOpen(false);
            setOpen(true);
          }
        }}
        onPointerLeave={scheduleHoverClose}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          cancelHoverClose();
          if (onTriggerClick) {
            closeMenu();
            onTriggerClick();
            return;
          }
          setFocusOnOpen(true);
          setOpen((current) => openOnHover || !current);
          setActiveSubmenu(null);
        }}
        ref={triggerRef}
        type="button"
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            <>
              {/* A hover-opened menu skips the scrim: it would cover the
                  trigger, fire pointerleave and close the menu in a loop. */}
              {openOnHover ? null : (
                <div
                  aria-hidden="true"
                  className="app-menu-scrim"
                  onPointerDown={() => closeMenu()}
                />
              )}
              {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- composite widget: focus is managed on its child items */}
              <div
                aria-label={label}
                className={`town-dropdown-enter ${menuClassName}`}
                data-side={menuSide}
                onPointerEnter={cancelHoverClose}
                onPointerLeave={scheduleHoverClose}
                onKeyDown={handleKeyDown}
                ref={menuRef}
                role="menu"
                style={position}
              >
                {header ? (
                  <div className="-mx-1 mb-1 border-b border-border px-3 py-2">
                    {header}
                  </div>
                ) : null}
                {items.map((item, index) => (
                  <ActionMenuItemButton
                    className={itemClassName}
                    iconClassName={iconClassName}
                    item={item}
                    key={item.label}
                    onOpenSubmenu={(focusFirstChild) => {
                      openSubmenu(index);
                      if (!focusFirstChild) return;
                      requestAnimationFrame(() =>
                        submenuRef.current
                          ?.querySelector<HTMLButtonElement>(
                            '[role="menuitem"]:not(:disabled)',
                          )
                          ?.focus(),
                      );
                    }}
                    onSelect={() => {
                      closeMenu();
                      item.onSelect?.();
                    }}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    submenuOpen={activeSubmenu === index}
                  />
                ))}
                {submenuItems ? (
                  <ActionSubmenu
                    items={submenuItems}
                    label={items[activeSubmenu!]?.label}
                    onBack={() => {
                      const parentIndex = activeSubmenu;
                      setActiveSubmenu(null);
                      itemRefs.current[parentIndex ?? -1]?.focus();
                    }}
                    onClose={closeMenu}
                    ref={submenuRef}
                    side={submenuSide}
                  />
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

function isViewportScrollTarget(target: EventTarget | null): boolean {
  return (
    target === window ||
    target === document ||
    target === document.documentElement ||
    target === document.body
  );
}

/** One gap between a menu and its trigger; one margin to the viewport edge. */
const MENU_GAP = 6;
const MENU_MARGIN = 8;

function computeMenuPosition(
  triggerRect: DOMRect,
  menuRect: DOMRect | undefined,
  placement: MenuPlacement,
) {
  const width = menuRect?.width ?? 232;
  const height = menuRect?.height ?? 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampLeft = (left: number) =>
    Math.max(MENU_MARGIN, Math.min(left, vw - width - MENU_MARGIN));
  const clampTop = (top: number) =>
    Math.max(MENU_MARGIN, Math.min(top, vh - height - MENU_MARGIN));

  if (placement === "right-start") {
    const right = triggerRect.right + MENU_GAP;
    const sideLeft =
      right + width <= vw - MENU_MARGIN
        ? right
        : Math.max(MENU_MARGIN, triggerRect.left - width - MENU_GAP);
    return { left: clampLeft(sideLeft), top: clampTop(triggerRect.top) };
  }
  if (placement === "top-start") {
    const above = triggerRect.top - MENU_GAP - height;
    const top =
      height > 0 && above < MENU_MARGIN ? triggerRect.bottom + MENU_GAP : above;
    return { left: clampLeft(triggerRect.left), top: clampTop(top) };
  }
  const left = clampLeft(
    placement === "bottom-start" ? triggerRect.left : triggerRect.right - width,
  );
  const below = triggerRect.bottom + MENU_GAP;
  const top =
    height > 0 && below + height > vh - MENU_MARGIN
      ? Math.max(MENU_MARGIN, triggerRect.top - height - MENU_GAP)
      : below;
  return { left, top: clampTop(top) };
}

function ActionMenuItemButton({
  className,
  iconClassName,
  item,
  onOpenSubmenu,
  onSelect,
  ref,
  submenuOpen,
}: {
  className: string;
  iconClassName: string;
  item: ActionMenuItem;
  onOpenSubmenu: (focusFirstChild: boolean) => void;
  onSelect: () => void;
  ref: Ref<HTMLButtonElement>;
  submenuOpen: boolean;
}) {
  return (
    <div>
      {item.separatorBefore ? (
        <div className="-mx-1 my-1 border-t border-border" />
      ) : null}
      <button
        aria-expanded={item.children ? submenuOpen : undefined}
        aria-haspopup={item.children ? "menu" : undefined}
        className={`${className} ${
          item.danger ? "text-destructive" : "text-foreground"
        }`}
        disabled={item.disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (item.children) {
            onOpenSubmenu(false);
            return;
          }
          onSelect();
        }}
        onKeyDown={(event) => {
          if (item.children && event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            onOpenSubmenu(true);
          }
        }}
        onPointerEnter={() => {
          if (item.children) onOpenSubmenu(false);
        }}
        ref={ref}
        role="menuitem"
        tabIndex={-1}
        type="button"
      >
        <span
          className={`${iconClassName} ${item.danger ? "" : "text-muted-foreground"}`}
        >
          {item.icon}
        </span>
        <span className="whitespace-nowrap">{item.label}</span>
        {item.children ? (
          <Icon
            className="ml-auto text-muted-foreground"
            icon={ArrowRight01Icon}
            size={14}
          />
        ) : null}
      </button>
    </div>
  );
}

function ActionSubmenu({
  items,
  label,
  onBack,
  onClose,
  ref,
  side,
}: {
  items: ActionMenuItem[];
  label?: string;
  onBack: () => void;
  onClose: () => void;
  ref: Ref<HTMLDivElement>;
  side: "left" | "right";
}) {
  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- composite widget: focus is managed on its child items
    <div
      aria-label={label}
      className={`app-popover-card absolute top-0 w-[180px] p-1 max-sm:static max-sm:mt-1 max-sm:w-full ${
        side === "left" ? "right-[calc(100%+4px)]" : "left-[calc(100%+4px)]"
      }`}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onBack();
        }
      }}
      ref={ref}
      role="menu"
    >
      {items.map((child) => (
        <button
          className="flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50"
          disabled={child.disabled}
          key={child.label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            child.onSelect?.();
          }}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {child.icon}
          </span>
          {child.label}
        </button>
      ))}
    </div>
  );
}
