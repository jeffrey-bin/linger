import "./meeting-page.css";

import { useQuery } from "@tanstack/react-query";
import {
  BookOpen01Icon,
  LeftToRightListBulletIcon,
  Loading03Icon,
  RefreshIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import {
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useMeetings } from "./memory-queries";
import { MeetingReader } from "./meeting-reader";
import { meetingsTabPath } from "./meetings-panel";

import {
  extractRenderedDocumentHeadings,
  type DocumentHeading,
} from "@/components/document-headings";
import { DocumentTableOfContents } from "@/components/document-table-of-contents";
import { useDocumentAnchorLinks } from "@/components/document-anchor-links";
import { resolveMemoryDocumentLink } from "./memory-document-links";
import { Button } from "@/components/ui/button";
import {
  WORKSPACE_TREE_ID,
  useWorkspaceTree,
} from "@/features/library/workspace-tree";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

/** One read-only meeting, named by the `entry` query of `/library/meetings`. */
export function MeetingPage() {
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceTree = useWorkspaceTree();
  const [tocOpen, setTocOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const selectedId = searchParams.get("entry");
  const meetings = useMeetings(tenantId);
  const listed = meetings.data?.find((entry) => entry.id === selectedId);
  const selected = useQuery({
    enabled: listed !== undefined,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/memory/{entryId}", {
          params: { path: { tenantId, entryId: listed?.id ?? "" } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "personal-memory", listed?.id],
    refetchInterval: 15_000,
  });
  const readable = listed && selected.data && !selected.error;
  const anchorLinks = useDocumentAnchorLinks(
    contentRef,
    readable ? `${tenantId}:${listed.id}` : undefined,
  );
  function openAnchor(event: SyntheticEvent) {
    anchorLinks.openAnchor(event);
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-surface">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 py-3 md:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Button
            aria-controls={WORKSPACE_TREE_ID}
            aria-expanded={workspaceTree.open}
            aria-label="Open Owned by Me"
            className="sm:hidden"
            onClick={() => workspaceTree.setOpen(true)}
            size="icon"
            title="Owned by Me"
            tone="ghost"
          >
            <Icon icon={SidebarLeftIcon} size={16} />
          </Button>
          <div className="flex items-center gap-2">
            <Icon icon={BookOpen01Icon} className="text-app-muted" size={16} />
            <h1 className="text-[15px] font-semibold text-app-ink">Meetings</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {readable ? (
            <Button
              aria-controls="meeting-table-of-contents"
              aria-expanded={tocOpen}
              aria-label="Table of contents"
              aria-pressed={tocOpen}
              onClick={() => setTocOpen((value) => !value)}
              size="icon"
              title="Table of contents"
              tone="ghost"
            >
              <Icon icon={LeftToRightListBulletIcon} size={16} />
            </Button>
          ) : null}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <section
          aria-label="Meeting content"
          className="workspace-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto"
          ref={contentRef}
          onClickCapture={openAnchor}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter") openAnchor(event);
          }}
        >
          {anchorLinks.error ? (
            <p className="px-6 py-2 text-sm text-app-danger" role="alert">
              {anchorLinks.error}
            </p>
          ) : null}
          {listed && selected.isPending ? (
            <div
              aria-busy="true"
              className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-app-muted"
            >
              <Icon icon={Loading03Icon} className="animate-spin" size={16} />
              Loading meeting...
            </div>
          ) : listed && selected.error ? (
            <div
              aria-label={selected.error.message || "Meeting is unavailable."}
              className="mx-auto max-w-3xl px-6 py-10"
              role="alert"
            >
              <p className="text-sm text-app-danger">
                {selected.error.message || "Meeting is unavailable."}
              </p>
              <Button
                className="mt-3"
                onClick={() => void selected.refetch()}
                size="compact"
                tone="secondary"
              >
                <Icon icon={RefreshIcon} size={14} /> Retry meeting
              </Button>
            </div>
          ) : listed && selected.data?.meeting ? (
            <MeetingReader
              entry={selected.data}
              file={searchParams.get("file")}
              onHidden={() => void navigate(meetingsTabPath(tenantId, "week"))}
              onSelectTab={(tab) =>
                setSearchParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    next.set("file", tab);
                    return next;
                  },
                  { replace: true },
                )
              }
              resolveLink={resolveMemoryDocumentLink}
              tenantId={tenantId}
            />
          ) : null}
        </section>
        {tocOpen && readable ? (
          <MeetingTableOfContents
            contentRef={contentRef}
            key={`${tenantId}:${listed.id}`}
            onClose={() => setTocOpen(false)}
          />
        ) : null}
      </div>
    </main>
  );
}

function MeetingTableOfContents({
  contentRef,
  onClose,
}: {
  contentRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const update = () => {
      setHeadings(
        extractRenderedDocumentHeadings(
          root.querySelector<HTMLElement>(
            '[data-content-renderer="blocknote"]',
          ),
        ),
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [contentRef]);
  return (
    <DocumentTableOfContents
      contentRef={contentRef}
      headings={headings}
      id="meeting-table-of-contents"
      onClose={onClose}
    />
  );
}
