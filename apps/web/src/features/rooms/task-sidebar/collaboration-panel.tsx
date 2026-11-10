import {
  ChampionIcon,
  File01Icon,
  GitMergeIcon,
  HierarchyIcon,
  RefreshIcon,
  RepeatIcon,
  SecurityCheckIcon,
  SplitIcon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubTeamMdDocument,
} from "@/features/teamhub/teamhub-types";

import { ActorAvatar } from "../members/actor-avatar";
import { PanelLoading } from "./panel-loading";
import {
  layoutTeamGraph,
  patternTitles,
  type Relationship,
  type RelationshipVisibility,
} from "./team-graph";
import { roomTeamMdQueryOptions } from "./team-md-query";

const patternIcons: Record<
  TeamHubTeamMdDocument["collaborate_pattern"],
  IconSvgElement
> = {
  "classify-and-act": SplitIcon,
  "fan-out-and-synthesize": GitMergeIcon,
  "adversarial-verification": SecurityCheckIcon,
  tournament: ChampionIcon,
  "loop-until-done": RepeatIcon,
};

export function CollaborationPanel({
  actors,
  hidden,
  roomId,
  tenantId,
}: {
  actors: TeamHubActorRef[];
  hidden: boolean;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  // team_md.published refreshes this query, so it does not poll.
  const query = useQuery({
    ...roomTeamMdQueryOptions(client, tenantId, roomId),
    enabled: !hidden,
  });
  const denied =
    query.error instanceof TeamHubError &&
    (query.error.status === 403 || query.error.status === 401);
  // Background refetches stay silent; only an explicit refresh spins.
  const [refreshing, setRefreshing] = useState(false);
  const patternIcon = query.data
    ? patternIcons[query.data.collaborate_pattern]
    : null;
  return (
    <section
      aria-label="Room collaboration"
      className={
        hidden
          ? "hidden"
          : "workspace-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto bg-app-surface"
      }
      hidden={hidden}
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 text-xs text-app-muted">
        {query.data && patternIcon ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-medium text-app-body">
              <Icon icon={patternIcon} size={14} />
              {patternTitles[query.data.collaborate_pattern]}
            </span>
            <span
              aria-hidden
              className="size-[3px] rounded-full bg-app-border-strong"
            />
            <span>{query.data.members.length + 1} Agents</span>
          </>
        ) : null}
        <Button
          aria-label="Refresh collaboration"
          className="ml-auto"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void query.refetch().finally(() => setRefreshing(false));
          }}
          size="icon"
          tone="ghost"
        >
          <Icon
            icon={RefreshIcon}
            size={14}
            className={
              refreshing ? "animate-spin motion-reduce:animate-none" : undefined
            }
          />
        </Button>
      </div>
      {query.isPending ? (
        <PanelLoading label="Loading collaboration" />
      ) : query.isError ? (
        <div className="p-6 text-sm" role="alert">
          <p>
            {denied
              ? "You no longer have access to this collaboration."
              : "Could not load collaboration."}
          </p>
          <Button
            className="mt-3"
            onClick={() => void query.refetch()}
            size="compact"
          >
            Retry
          </Button>
        </div>
      ) : query.data ? (
        <CollaborationGraph
          actors={actors}
          document={query.data}
          key={roomId}
        />
      ) : (
        <div className="px-6 py-12 text-center">
          <Icon
            icon={HierarchyIcon}
            className="mx-auto mb-3 text-app-muted"
            size={24}
          />
          <h3 className="text-sm font-medium">No collaboration plan yet</h3>
          <p className="mt-2 text-xs leading-5 text-app-muted">
            When an Agent publishes team.md for this Room, its team and
            relationships appear here.
          </p>
        </div>
      )}
    </section>
  );
}

const relationshipLabels: Record<Relationship, string> = {
  handoff: "Handoff",
  report: "Report",
};

function lineStroke(kind: Relationship) {
  return kind === "handoff"
    ? "var(--app-border-interactive)"
    : "var(--app-border-strong)";
}

type TeamGraph = ReturnType<typeof layoutTeamGraph>;

export function CollaborationGraph({
  actors,
  document,
}: {
  actors: TeamHubActorRef[];
  document: TeamHubTeamMdDocument;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [visible, setVisible] = useState<RelationshipVisibility>({
    handoff: true,
    report: true,
  });
  const [width, setWidth] = useState(360);
  const canvasRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      // clientWidth is whole pixels: a fractional box width would make the
      // graph a pixel wider than its container and scroll sideways.
      const next = canvas.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  const graph = layoutTeamGraph(document, width, visible);
  const coordinator = document.orchestrator.actor_id;
  const selected = graph.nodes.find((node) => node.actor_id === selectedId);
  const focusId =
    graph.nodes.find((node) => node.actor_id === hoveredId)?.actor_id ??
    selected?.actor_id;
  const touches = (path: { from: string; to: string }) =>
    path.from === focusId || path.to === focusId;
  const linked = new Set(
    graph.paths.filter(touches).flatMap((path) => [path.from, path.to]),
  );
  if (focusId) linked.add(focusId);
  // Highlighted lines are drawn last so they cover any shared trunk.
  const paths = [...graph.paths].sort(
    (a, b) => Number(touches(a)) - Number(touches(b)),
  );
  const displayName = (id: string) =>
    actors.find((actor) => actor.id === id)?.display_name ??
    graph.nodes.find((node) => node.actor_id === id)?.name ??
    id;
  const radius = graph.avatar / 2;
  const avatarSize = graph.avatar > 30 ? "sm" : "xs";
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- clicking the row background is a pointer shortcut; the contained controls stay keyboard accessible
    <div
      className="min-w-0 flex-1"
      onClick={(event) => {
        if (
          !(event.target instanceof Element) ||
          event.target.closest(
            "button,a,summary,details,[data-collaboration-detail]",
          )
        )
          return;
        setSelectedId(null);
      }}
    >
      <h3 className="mx-4 mb-3.5 mt-1 text-[15px] font-semibold leading-[1.4] text-pretty break-words text-app-ink">
        {document.task_goal}
      </h3>
      <div className="mx-3 overflow-hidden rounded-xl border border-app-border">
        <div
          className="workspace-scrollbar overflow-x-auto overflow-y-hidden"
          ref={canvasRef}
          role="group"
          aria-label="Agent collaboration graph"
        >
          <div
            className="relative mx-auto"
            style={{ width: graph.width, height: graph.height }}
            data-testid="collaboration-canvas"
          >
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={graph.width}
              height={graph.height}
              viewBox={`0 0 ${graph.width} ${graph.height}`}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.25"
            >
              {paths.map((path) => {
                const on = Boolean(focusId && touches(path));
                return (
                  <g
                    key={path.id}
                    data-relationship={path.kind}
                    data-faded={focusId && !on ? "true" : undefined}
                    stroke={on ? "var(--app-ink)" : lineStroke(path.kind)}
                    opacity={focusId && !on ? 0.22 : 1}
                  >
                    <path
                      d={path.d}
                      strokeDasharray={
                        path.kind === "report" ? "3 3.5" : undefined
                      }
                    />
                    <path d={path.arrow} strokeWidth="1.4" />
                  </g>
                );
              })}
              {graph.loop ? (
                <g
                  data-relationship="loop"
                  stroke={
                    focusId === coordinator
                      ? "var(--app-ink)"
                      : lineStroke("handoff")
                  }
                  opacity={focusId && focusId !== coordinator ? 0.22 : 1}
                >
                  <path d={graph.loop.d} />
                  <path d={graph.loop.arrow} strokeWidth="1.4" />
                </g>
              ) : null}
            </svg>
            {graph.nodes.map((node) => {
              const name = displayName(node.actor_id);
              const active = selected?.actor_id === node.actor_id;
              const lead = node.actor_id === coordinator;
              const faded = Boolean(focusId && !linked.has(node.actor_id));
              return (
                <button
                  type="button"
                  key={node.actor_id}
                  aria-label={`${name} · ${node.identity}`}
                  aria-pressed={active}
                  data-agent-id={node.actor_id}
                  data-center={node.center || undefined}
                  data-faded={faded || undefined}
                  title={`${name} · ${node.identity}${node.role ? `\n${node.role}` : ""}`}
                  className="group absolute flex w-20 -translate-x-1/2 flex-col items-center rounded-lg text-center transition-opacity focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-app-focus"
                  style={{
                    left: node.x,
                    top: node.y - radius - 2,
                    opacity: faded ? 0.35 : 1,
                  }}
                  onClick={() => setSelectedId(active ? null : node.actor_id)}
                  onPointerEnter={() => setHoveredId(node.actor_id)}
                  onPointerLeave={() => setHoveredId(null)}
                >
                  <span
                    className={`block rounded-[10px] p-0.5 transition-shadow ${
                      active
                        ? "shadow-[0_0_0_2px_var(--app-ink),0_0_0_5px_var(--app-selected)]"
                        : lead
                          ? "shadow-[0_0_0_1.5px_var(--app-ink)]"
                          : "group-hover:shadow-[0_0_0_1.5px_var(--app-border-strong)]"
                    }`}
                  >
                    <ActorAvatar
                      actorId={node.actor_id}
                      kind="agent"
                      name={name}
                      size={avatarSize}
                    />
                  </span>
                  <span className="mt-1.5 line-clamp-2 max-w-20 text-xs font-medium leading-[15px] break-words text-app-ink">
                    {name}
                  </span>
                  <span
                    className={`mt-px whitespace-nowrap text-[12px] leading-[14px] ${lead ? "font-medium text-app-ink" : "text-app-subtle"}`}
                  >
                    {node.identity}
                  </span>
                </button>
              );
            })}
            {graph.returned ? (
              <div
                aria-hidden
                className="pointer-events-none absolute flex w-20 -translate-x-1/2 flex-col items-center text-center transition-opacity"
                style={{
                  left: graph.returned.x,
                  top: graph.returned.y - radius - 2,
                  opacity: focusId && !linked.has(coordinator) ? 0.35 : 1,
                }}
              >
                <span className="block rounded-[10px] p-0.5 shadow-[0_0_0_1.25px_var(--app-border-strong)]">
                  <span className="block opacity-45 grayscale-[.4]">
                    <ActorAvatar
                      actorId={coordinator}
                      kind="agent"
                      name={displayName(coordinator)}
                      size={avatarSize}
                    />
                  </span>
                </span>
                <span className="mt-1.5 line-clamp-2 max-w-20 text-xs font-medium leading-[15px] break-words text-app-muted">
                  {displayName(coordinator)}
                </span>
                <span className="mt-px whitespace-nowrap text-[12px] leading-[14px] text-app-subtle">
                  {graph.loop ? "Decides" : "Collects"}
                </span>
              </div>
            ) : null}
            {graph.loop ? (
              <span
                className="absolute inline-flex h-[22px] -translate-x-1/2 -translate-y-1/2 items-center gap-[5px] whitespace-nowrap rounded-full border border-app-border bg-app-surface px-2.5 text-[12px] text-app-muted"
                style={{ left: graph.loop.labelX, top: graph.loop.labelY }}
              >
                <Icon icon={RepeatIcon} size={12} />
                Repeat until done
              </span>
            ) : null}
          </div>
        </div>
        <div
          className="flex items-center gap-1 border-t border-app-border bg-app-surface-soft/40 py-1.5 pl-3 pr-2 text-[12px] text-app-muted"
          aria-label="Relationship legend"
          role="group"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] shadow-[inset_0_0_0_1.5px_var(--app-ink)]" />
            Coordinator
          </span>
          {(["handoff", "report"] as const).map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={visible[kind]}
              onClick={() =>
                setVisible((current) => ({
                  ...current,
                  [kind]: !current[kind],
                }))
              }
              className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 first-of-type:ml-auto hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-app-focus ${visible[kind] ? "" : "text-app-border-strong line-through"}`}
            >
              <svg aria-hidden width="18" height="6">
                <path
                  d="M1 3H17"
                  stroke={
                    visible[kind] ? lineStroke(kind) : "var(--app-border)"
                  }
                  strokeWidth="1.5"
                  strokeDasharray={kind === "report" ? "3 3" : undefined}
                />
              </svg>
              {relationshipLabels[kind]}
            </button>
          ))}
        </div>
      </div>
      <div
        className="px-4 pb-4 pt-3.5 text-xs leading-5"
        aria-live="polite"
        data-collaboration-detail
      >
        {selected ? (
          <AgentDetail
            displayName={displayName}
            edges={graph.edges}
            node={selected}
          />
        ) : (
          <p className="text-center text-app-subtle">
            Select an Agent to see its responsibility and who it works with.
          </p>
        )}
      </div>
      <details className="group mx-4 border-t border-app-border text-[12px]">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-app-subtle [&::-webkit-details-marker]:hidden">
          <Icon icon={File01Icon} size={12} />
          team.md · Revision {document.revision}
          <span className="ml-auto text-app-muted hover:text-app-ink group-open:hidden">
            View source
          </span>
          <span className="ml-auto hidden text-app-muted hover:text-app-ink group-open:inline">
            Hide source
          </span>
        </summary>
        <pre className="mb-4 whitespace-pre-wrap break-words rounded-lg bg-app-sidebar p-3 font-mono text-[12px] leading-[1.55] text-app-body">
          {document.raw_markdown}
        </pre>
      </details>
    </div>
  );
}

function AgentDetail({
  displayName,
  edges,
  node,
}: {
  displayName: (id: string) => string;
  edges: TeamGraph["edges"];
  node: TeamGraph["nodes"][number];
}) {
  const name = displayName(node.actor_id);
  const related = (direction: "from" | "to") =>
    edges.flatMap((edge) =>
      edge[direction === "from" ? "to" : "from"] === node.actor_id
        ? [
            {
              id: edge[direction],
              kind: edge.kinds.includes("handoff")
                ? ("handoff" as const)
                : ("report" as const),
            },
          ]
        : [],
    );
  const rows = [
    ...(name !== node.name ? [["Name in team.md", node.name] as const] : []),
    ["Receives from", related("from")] as const,
    ["Sends to", related("to")] as const,
  ];
  return (
    <>
      <div className="flex items-center gap-2.5">
        <ActorAvatar
          actorId={node.actor_id}
          kind="agent"
          name={name}
          size="nav"
        />
        <div className="min-w-0">
          <h4 className="break-words text-[14px] font-semibold leading-5">
            {name}
          </h4>
          <p className="text-[12px] leading-4 text-app-muted">
            {node.identity}
          </p>
        </div>
      </div>
      <p className="mb-3 mt-2.5 whitespace-pre-wrap break-words text-[14px] leading-[1.5] text-app-body">
        {node.role?.trim() || "No responsibility specified in team.md."}
      </p>
      <dl className="grid gap-2">
        {rows.map(([label, value]) => (
          <div className="grid grid-cols-[104px_1fr] gap-2" key={label}>
            <dt className="whitespace-nowrap text-[12px] leading-[22px] text-app-subtle">
              {label}
            </dt>
            <dd className="flex min-w-0 flex-wrap gap-1 break-words leading-[22px]">
              {typeof value === "string" ? (
                value
              ) : value.length ? (
                value.map(({ id, kind }) => (
                  <span
                    key={`${id}-${kind}`}
                    className="inline-flex h-[22px] items-center gap-[5px] rounded-md bg-app-sidebar pl-[3px] pr-[7px] text-[12px] text-app-body"
                  >
                    <ActorAvatar
                      actorId={id}
                      kind="agent"
                      name={displayName(id)}
                      size="micro"
                    />
                    {displayName(id)}
                    {kind === "report" ? (
                      <span className="text-[12px] text-app-subtle">
                        report
                      </span>
                    ) : null}
                  </span>
                ))
              ) : (
                <span className="text-xs text-app-subtle">None</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
