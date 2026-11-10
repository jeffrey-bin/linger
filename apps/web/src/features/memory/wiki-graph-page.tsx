import { useQuery } from "@tanstack/react-query";
import {
  HierarchySquare01Icon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { lazy, Suspense, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import {
  filterWikiGraph,
  useWikiDisplayState,
} from "@/features/wiki/wiki-display-state";
import { usePersonalWikiRefresh } from "@/features/wiki/wiki-refresh";
import { WikiRefreshBanner } from "@/features/wiki/wiki-refresh-status";
import { useAnotherMeActorId } from "@/features/wiki/wiki-working-card";
import { nodeMoments, parseEmbeddedWikiGraph } from "./wiki-graph-model";
import { WikiBack } from "@/features/wiki/wiki-home-page";
import { WikiKnowledgeGraph } from "./wiki-knowledge-graph";
import { usePeriodReports } from "./wiki-period-reports";

const DailyPanel = lazy(async () => {
  const { WikiGraphDailyPanel } = await import("./wiki-graph-daily-panel");
  return { default: WikiGraphDailyPanel };
});

const ReportCards = lazy(async () => {
  const { WikiGraphReportCards } = await import("./wiki-graph-report-cards");
  return { default: WikiGraphReportCards };
});

export function WikiGraphPage() {
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [searchParams] = useSearchParams();
  const initialDay = searchParams.get("day");
  const reports = usePeriodReports(tenantId, "daily");
  const anotherMe = useAnotherMeActorId(tenantId);
  const [selectedReport, setSelectedReport] = useState<
    | {
        kind: "daily" | "weekly";
        day: string;
      }
    | undefined
  >(() =>
    initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay)
      ? { kind: "daily", day: initialDay }
      : undefined,
  );
  const graph = useQuery({
    queryFn: () => client.getPersonalKnowledgeGraphVisualization(tenantId),
    queryKey: ["teamhub", tenantId, "personal-wiki", "graph"],
  });
  const display = useWikiDisplayState(tenantId);
  const parsedGraph = useMemo(
    () => (graph.data ? parseEmbeddedWikiGraph(graph.data) : undefined),
    [graph.data],
  );
  const filteredGraph = useMemo(
    () =>
      parsedGraph ? filterWikiGraph(parsedGraph, display.decisions) : undefined,
    [parsedGraph, display.decisions],
  );
  const timelineMoments = useMemo(
    () => (filteredGraph ? nodeMoments(filteredGraph) : undefined),
    [filteredGraph],
  );
  const refresh = usePersonalWikiRefresh(tenantId);
  const graphBusy = refresh.refreshing || graph.isFetching;

  return (
    <main className="wiki-graph-page flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-surface">
      <header className="wiki-graph-page-header px-4 pt-4 pb-6">
        <WikiBack />
        <h1 className="mb-2 text-2xl text-foreground">Daily report</h1>
        <p className="text-sm text-muted-foreground">
          {reports.isPending
            ? "Loading reports…"
            : `${reports.data?.length ?? 0} reports · Browse by day`}
        </p>
      </header>

      <div className="px-3 md:px-4">
        <WikiRefreshBanner {...refresh} agentActorId={anotherMe} />
      </div>

      <section className="min-h-0 flex-1 overflow-hidden p-3 md:p-4">
        {graph.isPending ||
        (refresh.initializing && !graph.data) ||
        (graphBusy && !graph.data && !graph.error) ? (
          <div
            aria-busy="true"
            className="flex h-full min-h-[480px] items-center justify-center gap-2 text-sm text-app-muted"
          >
            <Icon icon={Loading03Icon} className="animate-spin" size={16} />
            <span
              className={refresh.initializing ? "town-shimmer-text" : undefined}
            >
              {refresh.initializing
                ? "Wiki is being generated…"
                : "Loading timeline…"}
            </span>
          </div>
        ) : graph.error ? (
          <div
            aria-label={graph.error.message || "Timeline is unavailable."}
            className="flex h-full min-h-[480px] flex-col items-center justify-center text-center"
            role="alert"
          >
            <Icon
              icon={HierarchySquare01Icon}
              className="mb-3 text-app-muted"
              size={24}
            />
            <p className="text-sm text-app-danger">
              {graph.error.message || "Timeline is unavailable."}
            </p>
            <Button
              className="mt-3"
              onClick={() => void graph.refetch()}
              size="compact"
              tone="secondary"
            >
              <Icon icon={RefreshIcon} size={14} /> Retry graph
            </Button>
          </div>
        ) : filteredGraph ? (
          <WikiKnowledgeGraph
            graph={filteredGraph}
            timelineMoments={timelineMoments}
            key={`${tenantId}:${graph.dataUpdatedAt}`}
            onReadingModeChange={() => setSelectedReport(undefined)}
            renderTimeline={(pages, granularity, navigation) => (
              <Suspense
                fallback={
                  <p role="status" className="p-6 text-sm text-app-muted">
                    Loading timeline…
                  </p>
                }
              >
                <ReportCards
                  tenantId={tenantId}
                  pages={pages}
                  moments={timelineMoments!}
                  granularity={granularity}
                  focus={navigation.focus}
                  onPeriodChange={navigation.onPeriodChange}
                  onSelectReport={(kind, day) =>
                    setSelectedReport({ kind, day })
                  }
                />
              </Suspense>
            )}
            dailyPanel={
              selectedReport ? (
                <Suspense
                  fallback={
                    <div role="status" className="wiki-graph-daily-panel p-4">
                      Loading Daily…
                    </div>
                  }
                >
                  <DailyPanel
                    key={tenantId}
                    day={selectedReport.day}
                    kind={selectedReport.kind}
                    tenantId={tenantId}
                    onClose={() => setSelectedReport(undefined)}
                  />
                </Suspense>
              ) : null
            }
          />
        ) : Object.values(display.decisions).includes("delete") ? (
          <p role="alert" className="p-4 text-sm text-app-muted">
            This graph cannot display your hidden-file preferences. Refresh the
            graph to load the current view.
          </p>
        ) : (
          <iframe
            className="block h-full min-h-[480px] w-full border border-app-border bg-app-surface"
            key={tenantId}
            sandbox="allow-scripts"
            srcDoc={graph.data}
            title="Personal knowledge graph"
          />
        )}
      </section>
    </main>
  );
}
