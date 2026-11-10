import { ArrowLeft01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Link } from "react-router";

import { secondaryNavigationHeaderClass } from "@/components/ui/secondary-navigation";
import { useSecondaryNavigationWidth } from "@/components/ui/use-sidebar-width";
import { MeetingsSidebarTree } from "@/features/wiki/knowledge-sidebar-trees";

import { WikiDirectory } from "@/features/wiki/wiki-directory";

export type LibrarySection =
  | "my-documents"
  | "overview"
  | "shared-with-me"
  | "wiki";

/**
 * Opened beside a Document, the sidebar is for switching: Back to Library
 * returns to finding files, and My pages, Shared with me, and Meetings list
 * what the reader can move to next.
 */
export function LibrarySidebar({
  active,
  children,
  id,
  mobileOpen = false,
  onMobileClose,
  holdsOpenFile = null,
  tenantId,
}: {
  active: LibrarySection | null;
  children: ReactNode;
  id?: string;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** The knowledge collection the routed file belongs to, if any. */
  holdsOpenFile?: "wiki" | null;
  tenantId: string;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const wikiOnly = active === "wiki" || holdsOpenFile === "wiki";
  const sidebarLabel = wikiOnly ? "Wiki" : "Library";
  const scrollKey = `linger:${wikiOnly ? "wiki" : "library"}-sidebar-scroll:${tenantId}`;
  const navigationWidth = useSecondaryNavigationWidth(tenantId);
  useLayoutEffect(() => {
    const stored = Number(window.sessionStorage.getItem(scrollKey));
    const sidebar = sidebarRef.current;
    if (!Number.isFinite(stored) || stored <= 0 || !sidebar) return;
    const restore = () => {
      sidebar.scrollTop = stored;
      return sidebar.scrollTop >= stored - 1;
    };
    if (restore()) return;
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    const stop = () => observer.disconnect();
    observer.observe(sidebar, { childList: true, subtree: true });
    sidebar.addEventListener("wheel", stop, { passive: true });
    sidebar.addEventListener("touchstart", stop, { passive: true });
    sidebar.addEventListener("pointerdown", stop);
    return () => {
      observer.disconnect();
      sidebar.removeEventListener("wheel", stop);
      sidebar.removeEventListener("touchstart", stop);
      sidebar.removeEventListener("pointerdown", stop);
    };
  }, [scrollKey]);

  const aside = (
    <aside
      aria-label={`${sidebarLabel} sidebar`}
      data-voice-scroll="sidebar"
      className={`workspace-scrollbar shrink-0 overflow-y-auto ${wikiOnly ? "overflow-x-hidden" : ""} bg-app-surface px-2 pb-3 sm:w-[calc(var(--sidebar-width)+20px)] sm:pl-[10px] sm:pr-[18px] ${
        mobileOpen
          ? "max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-40 max-sm:block max-sm:w-[min(300px,85vw)] max-sm:shadow-xl"
          : "max-sm:hidden"
      }`}
      id={id}
      onScroll={(event) =>
        window.sessionStorage.setItem(
          scrollKey,
          String(event.currentTarget.scrollTop),
        )
      }
      ref={(node) => {
        sidebarRef.current = node;
        navigationWidth.styleRef.current = node;
      }}
      style={navigationWidth.style}
    >
      {wikiOnly ? (
        <WikiDirectory tenantId={tenantId} onFileOpen={onMobileClose} />
      ) : (
        <>
          <header
            className={`${secondaryNavigationHeaderClass} sticky top-0 z-10 bg-app-surface`}
          >
            <Link
              className="-ml-1.5 inline-flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-[14px] font-medium text-app-ink transition-colors hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
              onClick={onMobileClose}
              to={`/t/${encodeURIComponent(tenantId)}/library`}
            >
              <Icon icon={ArrowLeft01Icon} className="shrink-0" size={16} />
              <span className="truncate">Back to Library</span>
            </Link>
            {mobileOpen && onMobileClose ? (
              <button
                aria-label="Close Owned by Me"
                className="flex size-8 shrink-0 items-center justify-center rounded-sm text-app-muted hover:bg-app-hover hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus sm:hidden"
                onClick={onMobileClose}
                title="Close Owned by Me"
                type="button"
              >
                <Icon icon={Cancel01Icon} size={16} />
              </button>
            ) : null}
          </header>
          <div className="pt-2">{children}</div>
          <div className="mt-1">
            <MeetingsSidebarTree
              key={tenantId}
              onFileOpen={onMobileClose}
              tenantId={tenantId}
            />
          </div>
        </>
      )}
    </aside>
  );

  return (
    <>
      {aside}
      <div className="relative hidden w-px shrink-0 bg-border sm:block">
        <div
          {...navigationWidth.handleProps}
          aria-label={`Resize ${sidebarLabel} sidebar`}
        />
      </div>
    </>
  );
}
