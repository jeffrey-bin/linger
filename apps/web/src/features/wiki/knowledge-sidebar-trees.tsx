import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { documentFileName } from "@/features/library/document-display-name";
import { WorkspaceFileIcon } from "@/features/library/workspace-file-icon";
import { useLibraryTreeState } from "@/features/library/use-library-tree-state";
import { personalWikiDocumentsQueryKey } from "@/features/teamhub/document-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import {
  WORKSPACE_HEADING_ICON_SIZE,
  WORKSPACE_TREE_CHEVRON_SIZE,
  workspaceHeadingActionClass,
  workspaceHeadingToggleClass,
} from "@/features/library/workspace-sidebar-styles";
import type {
  TeamHubDocument,
  TeamHubDocumentPage,
} from "@/features/teamhub/teamhub-types";

import { useWikiDisplayState, wikiPageKey } from "./wiki-display-state";

import { meetingPath, useMeetings } from "@/features/memory/memory-queries";
import {
  formatMeetingDay,
  formatMeetingWhen,
  meetingsByDate,
  type CalendarMeeting,
} from "@/features/memory/meetings-calendar";
import { meetingsTabPath } from "@/features/memory/meetings-panel";

/**
 * The read-only Meetings collection beside an opened Document or meeting. It
 * starts collapsed and unfolds once when the route opens one of its meetings.
 */
export function MeetingsSidebarTree({
  onFileOpen,
  tenantId,
}: {
  onFileOpen?: () => void;
  tenantId: string;
}) {
  const location = useLocation();
  // A collapsed collection never renders its tree, so it cannot learn from the
  // tree whether it holds the open meeting; the route says so on its own.
  const holdsRoutedMeeting =
    location.pathname.endsWith("/library/meetings") &&
    new URLSearchParams(location.search).has("entry");
  const [collapsed, setCollapsed] = useLibraryTreeState(
    tenantId,
    "meetings-collapsed",
    () => true,
  );
  // A meeting opened by link must be visible in the tree, so the reader can see
  // where it sits. Opening is one-way: collapsing it again stays collapsed.
  const openedForRoutedMeeting = useRef(false);
  useEffect(() => {
    if (!holdsRoutedMeeting) {
      openedForRoutedMeeting.current = false;
      return;
    }
    if (openedForRoutedMeeting.current) return;
    openedForRoutedMeeting.current = true;
    setCollapsed(false);
  }, [holdsRoutedMeeting, setCollapsed]);
  const label = "Meetings";
  const contentId = "library-meetings-collection";

  return (
    <section aria-label={`${label} tree`}>
      {/* The tree marks the open meeting, not the collection holding it. */}
      <div className="flex items-center justify-between gap-1">
        <button
          aria-controls={contentId}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          className={workspaceHeadingToggleClass}
          onClick={() => setCollapsed((value) => !value)}
          title={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          type="button"
        >
          <Icon
            icon={Calendar03Icon}
            className="shrink-0 text-app-muted"
            size={WORKSPACE_HEADING_ICON_SIZE}
          />
          <span className="truncate">{label}</span>
        </button>
        <Link
          aria-label={`Open ${label}`}
          className={workspaceHeadingActionClass}
          title={`Open ${label}`}
          to={meetingsTabPath(tenantId, "week")}
        >
          <Icon icon={ArrowRight01Icon} size={WORKSPACE_HEADING_ICON_SIZE} />
        </Link>
      </div>
      <div hidden={collapsed} id={contentId}>
        {!collapsed ? (
          <div className="mt-2 ml-4">
            <MeetingFiles onFileOpen={onFileOpen} tenantId={tenantId} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function useWikiDocuments(tenantId: string) {
  const { client } = useTeamHubRuntime();
  const documents = useInfiniteQuery<
    TeamHubDocumentPage,
    Error,
    InfiniteData<TeamHubDocumentPage>,
    ReturnType<typeof personalWikiDocumentsQueryKey>,
    string | undefined
  >({
    getNextPageParam: (lastPage, _pages, _pageParam, pageParams) => {
      const next = lastPage.page.has_more
        ? lastPage.page.next_cursor
        : undefined;
      return next && !pageParams.includes(next) ? next : undefined;
    },
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/personal-wiki/documents", {
          params: {
            path: { tenantId },
            query: { ...(pageParam ? { cursor: pageParam } : {}), limit: 50 },
          },
        }),
      );
      if (
        page.items.some(
          (item) =>
            item.tenant_id !== tenantId ||
            item.owner.tenant_id !== tenantId ||
            item.creator.tenant_id !== tenantId,
        )
      ) {
        throw new Error("Wiki Documents are unavailable.");
      }
      return page;
    },
    queryKey: personalWikiDocumentsQueryKey(tenantId),
    staleTime: 60_000,
  });
  const { data, fetchNextPage, hasNextPage, isError, isFetching } = documents;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [data, fetchNextPage, hasNextPage, isError, isFetching]);
  return documents;
}

export function WikiFileTree({
  onFileOpen,
  tenantId,
}: {
  onFileOpen?: () => void;
  tenantId: string;
}) {
  const { documentId } = useParams();
  const display = useWikiDisplayState(tenantId);
  const documents = useWikiDocuments(tenantId);
  const pages = useMemo(() => {
    const items: TeamHubDocument[] = [];
    for (const page of documents.data?.pages ?? []) {
      for (const item of page.items) {
        if (
          item.from.some((source) => source.binding_kind === "wiki_page") &&
          display.decisions[wikiPageKey(wikiPagePath(item))] !== "delete" &&
          wikiPagePath(item).split("/").at(-1)?.toLowerCase() !== "index.md" &&
          !meetingSessionPage.test(wikiPagePath(item))
        ) {
          items.push(item);
        }
      }
    }
    return items;
  }, [documents.data, display.decisions]);
  const tree = useMemo<WikiTreeNode[]>(
    () => buildWikiDocumentTree(pages),
    [pages],
  );
  const [expandedPaths, setExpandedPaths] = useLibraryTreeState<Set<string>>(
    tenantId,
    "wiki-folders",
    () => new Set(),
  );
  const rows = flattenWikiTree(tree, expandedPaths);
  // Opening a Document by link lands with its folder collapsed, so the file that
  // is being read is not in the tree at all. Expand its ancestors once per
  // Document; the row itself scrolls into view when it renders.
  const revealedDocumentId = useRef<string | null>(null);
  useEffect(() => {
    if (!documentId || revealedDocumentId.current === documentId) return;
    const page = pages.find((item) => item.id === documentId);
    if (!page) return;
    revealedDocumentId.current = documentId;
    const segments = wikiPagePath(page).split("/").filter(Boolean);
    segments.pop();
    if (segments.length === 0) return;
    setExpandedPaths((current) => {
      const next = new Set(current);
      let prefix = "";
      for (const segment of segments) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        next.add(prefix);
      }
      return next;
    });
  }, [documentId, pages, setExpandedPaths]);

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (documents.isPending)
    return <TreeMessage busy>Loading Wiki Documents…</TreeMessage>;
  if (documents.error)
    return (
      <TreeError
        message={documents.error.message || "Wiki Documents are unavailable."}
        onRetry={() => void documents.refetch()}
        label="Retry Wiki"
      />
    );

  return (
    <section aria-label="Pages" className="space-y-0.5">
      {pages.length === 0 && !documents.hasNextPage ? (
        <TreeMessage>No generated pages yet.</TreeMessage>
      ) : (
        rows.map(({ depth, node }) => {
          const paddingLeft = 8 + depth * 16;
          if (node.kind === "directory") {
            const collapsed = !expandedPaths.has(node.path);
            return (
              <button
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.name}`}
                className="flex h-[33px] w-full items-center gap-2 rounded-md pr-2 text-left text-[14px] leading-[18px] text-muted-foreground hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
                key={`directory:${node.path}`}
                onClick={() => toggleDirectory(node.path)}
                style={{ paddingLeft }}
                type="button"
              >
                {collapsed ? (
                  <Icon
                    icon={ArrowRight01Icon}
                    className="shrink-0"
                    size={WORKSPACE_TREE_CHEVRON_SIZE}
                  />
                ) : (
                  <Icon
                    icon={ArrowDown01Icon}
                    className="shrink-0"
                    size={WORKSPACE_TREE_CHEVRON_SIZE}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
              </button>
            );
          }
          return (
            <KnowledgeFileLink
              current={node.document.id === documentId}
              filename={node.name}
              key={node.document.id}
              onOpen={onFileOpen}
              paddingLeft={paddingLeft}
              reveal={node.document.id === documentId}
              title={node.name}
              to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(node.document.id)}`}
            />
          );
        })
      )}
      {documents.isFetchingNextPage ? (
        <TreeMessage busy>Loading Wiki Documents…</TreeMessage>
      ) : null}
    </section>
  );
}

/**
 * Every meeting grouped by day, newest day first, so switching to another
 * meeting stays in the sidebar. Day labels are small muted headings over the
 * regular meeting rows.
 */
function MeetingFiles({
  onFileOpen,
  tenantId,
}: {
  onFileOpen?: () => void;
  tenantId: string;
}) {
  const meetings = useMeetings(tenantId);
  const location = useLocation();
  const currentId = new URLSearchParams(location.search).get("entry");
  const days = useMemo(
    () =>
      [...meetingsByDate(meetings.data ?? [])]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([date, items]) => ({ date, items: [...items].reverse() })),
    [meetings.data],
  );

  if (meetings.isPending)
    return <TreeMessage busy>Loading Meetings…</TreeMessage>;
  if (meetings.error)
    return (
      <TreeError
        label="Retry Meetings"
        message="Meetings are unavailable."
        onRetry={() => void meetings.refetch()}
      />
    );
  if (days.length === 0)
    return <TreeMessage>No completed meetings yet.</TreeMessage>;

  return (
    <div className="space-y-1">
      {days.map((day) => (
        <section aria-label={`Meetings on ${day.date}`} key={day.date}>
          <h3 className="flex h-[24px] items-center px-2 text-[12px] font-medium text-app-muted">
            {formatMeetingDay(day.date)}
          </h3>
          <ul className="space-y-0.5">
            {day.items.map((meeting) => (
              <li key={meeting.id}>
                <MeetingLink
                  current={meeting.id === currentId}
                  meeting={meeting}
                  onOpen={onFileOpen}
                  to={meetingPath(tenantId, meeting.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MeetingLink({
  current,
  meeting,
  onOpen,
  to,
}: {
  current: boolean;
  meeting: CalendarMeeting;
  onOpen?: () => void;
  to: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  return (
    <Link
      aria-current={current ? "page" : undefined}
      aria-label={`Meeting ${meeting.date} ${meeting.time}`}
      className={`flex h-[33px] w-full min-w-0 items-center gap-2 rounded-md pl-[26px] pr-2 text-left text-[14px] leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus ${current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-app-hover"}`}
      onClick={onOpen}
      ref={ref}
      title={`Meeting · ${meeting.date} ${meeting.time}`}
      to={to}
    >
      <span className="min-w-0 flex-1 truncate">
        Meeting {formatMeetingWhen(meeting.date, meeting.time)}
      </span>
    </Link>
  );
}

function KnowledgeFileLink({
  current,
  filename,
  onOpen,
  paddingLeft = 8,
  reveal = false,
  title,
  to,
}: {
  current: boolean;
  filename: string;
  onOpen?: () => void;
  paddingLeft?: number;
  reveal?: boolean;
  /** The row's single line, as Figma 8940:25817 labels its files. */
  title: string;
  to: string;
}) {
  const revealRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!reveal) return;
    revealRef.current?.scrollIntoView({ block: "nearest" });
  }, [reveal, to]);
  return (
    <Link
      ref={revealRef}
      aria-current={current ? "page" : undefined}
      className={`flex h-[33px] w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left transition-colors text-[14px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus ${current ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-app-hover"}`}
      onClick={onOpen}
      style={{ paddingLeft }}
      // The row shows one line; hovering still names the file behind it.
      title={filename}
      to={to}
    >
      {/* Stands in for the folder chevron, so files line up under folders. */}
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      <WorkspaceFileIcon compact filename={filename} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}

function TreeError({
  label,
  message,
  onRetry,
}: {
  label: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div aria-label={message} className="px-2 py-3" role="alert">
      <p className="text-xs text-app-danger">{message}</p>
      <Button
        className="mt-2"
        onClick={onRetry}
        size="compact"
        tone="secondary"
      >
        <Icon icon={RefreshIcon} size={14} />
        {label}
      </Button>
    </div>
  );
}

function TreeMessage({
  busy = false,
  children,
}: {
  busy?: boolean;
  children: string;
}) {
  return (
    <p
      aria-busy={busy || undefined}
      // Sits under the collection label like My pages' empty state: the
      // tree's 16px indent plus 14px lands on the same 30px column.
      className="flex items-center gap-2 py-3 pl-[14px] pr-2 text-xs text-muted-foreground"
    >
      {busy ? <Spinner size={14} /> : null}
      {children}
    </p>
  );
}

type WikiTreeNode = WikiTreeDirectory | WikiTreePage;

interface WikiTreeDirectory {
  children: WikiTreeNode[];
  kind: "directory";
  name: string;
  path: string;
}

interface WikiTreePage {
  document: TeamHubDocument;
  kind: "page";
  name: string;
  path: string;
}

interface MutableWikiDirectory {
  directories: Map<string, MutableWikiDirectory>;
  name: string;
  pages: WikiTreePage[];
  path: string;
}

function buildWikiDocumentTree(documents: TeamHubDocument[]): WikiTreeNode[] {
  const root: MutableWikiDirectory = {
    directories: new Map(),
    name: "",
    pages: [],
    path: "",
  };
  for (const document of documents) {
    const pagePath = wikiPagePath(document);
    const segments = pagePath.split("/").filter(Boolean);
    const name = segments.pop() ?? documentFileName(document);
    let directory = root;
    for (const segment of segments) {
      const childPath = directory.path
        ? `${directory.path}/${segment}`
        : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = {
          directories: new Map(),
          name: segment,
          pages: [],
          path: childPath,
        };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.pages.push({ document, kind: "page", name, path: pagePath });
  }
  return finalizeWikiDirectory(root);
}

function finalizeWikiDirectory(
  directory: MutableWikiDirectory,
): WikiTreeNode[] {
  const directories: WikiTreeDirectory[] = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child) => ({
      children: finalizeWikiDirectory(child),
      kind: "directory",
      name: child.name,
      path: child.path,
    }));
  const pages = directory.pages.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return [...directories, ...pages];
}

function flattenWikiTree(
  nodes: WikiTreeNode[],
  expandedPaths: ReadonlySet<string>,
  depth = 0,
): Array<{ depth: number; node: WikiTreeNode }> {
  return nodes.flatMap((node) => [
    { depth, node },
    ...(node.kind === "directory" && expandedPaths.has(node.path)
      ? flattenWikiTree(node.children, expandedPaths, depth + 1)
      : []),
  ]);
}

// A recording's Session summary is shown as summary.md in its Meeting folder;
// listing it again under Wiki sessions/ would duplicate it.
const meetingSessionPage =
  /^sessions\/\d{4}-\d{2}-\d{2}\/capture_session_[A-Za-z0-9_-]+\.md$/u;

function wikiPagePath(document: TeamHubDocument) {
  return (
    document.from.find((source) => source.binding_kind === "wiki_page")
      ?.page_key ?? documentFileName(document)
  );
}
