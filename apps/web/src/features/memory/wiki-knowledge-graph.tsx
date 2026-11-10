import { Search01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import "./wiki-knowledge-graph.css";
import {
  buildTimeline,
  nodeMoments,
  type NodeMoment,
  type TimeGranularity,
  type WikiGraphData,
  type WikiGraphNode,
} from "./wiki-graph-model";
import { WikiGraphTimeline } from "./wiki-graph-timeline";

/** Daily or Weekly report cards above a ruler of dated Wiki pages. */
export function WikiKnowledgeGraph({
  graph,
  timelineMoments,
  renderTimeline,
  onReadingModeChange,
  dailyPanel,
}: {
  graph: WikiGraphData;
  timelineMoments?: Map<string, NodeMoment[]>;
  renderTimeline?: (
    pages: WikiGraphNode[],
    granularity: TimeGranularity,
    navigation: {
      focus?: { day: string; request: number };
      onPeriodChange: (day: string) => void;
    },
  ) => ReactNode;
  onReadingModeChange?: () => void;
  dailyPanel?: ReactNode;
}) {
  const [granularity, setGranularity] = useState<TimeGranularity>("day");
  const [query, setQuery] = useState("");
  const moments = useMemo(
    () => timelineMoments ?? nodeMoments(graph),
    [graph, timelineMoments],
  );
  const timeline = useMemo(
    () => buildTimeline(moments, granularity),
    [granularity, moments],
  );
  const lastBucket = Math.max(0, timeline.buckets.length - 1);
  // The playhead starts on the latest bucket.
  const [cursor, setCursor] = useState(lastBucket);
  // True once a day is picked; Latest returns to the unfocused view.
  const [focused, setFocused] = useState(false);
  const [cardFocus, setCardFocus] = useState<{
    day: string;
    request: number;
  }>();
  const pickDay = (index: number) => {
    setCursor(index);
    setFocused(true);
    const day = timeline.buckets[index]?.start;
    if (day)
      setCardFocus((previous) => ({
        day,
        request: (previous?.request ?? 0) + 1,
      }));
  };
  const followCard = (day: string) => {
    const index = timeline.buckets.findIndex((bucket) => bucket.start === day);
    if (index < 0) return;
    setCursor(index);
    setFocused(true);
  };
  const showAll = useCallback(() => setFocused(false), []);

  const changeGranularity = (next: TimeGranularity) => {
    if (next === granularity) return;
    onReadingModeChange?.();
    // Keep the playhead on the same day when switching between day and week buckets.
    const day = timeline.buckets[cursor]?.start;
    const nextTimeline = buildTimeline(moments, next);
    const locate = (day: string | undefined, fallback: number) => {
      if (!day) return fallback;
      let index = -1;
      nextTimeline.buckets.forEach((bucket, position) => {
        if (bucket.start <= day) index = position;
      });
      return index < 0 ? fallback : index;
    };
    const last = Math.max(0, nextTimeline.buckets.length - 1);
    const nextCursor = cursor === lastBucket ? last : locate(day, last);
    setCursor(nextCursor);
    setGranularity(next);
    const nextDay = nextTimeline.buckets[nextCursor]?.start;
    setCardFocus((previous) =>
      focused && nextDay
        ? { day: nextDay, request: (previous?.request ?? 0) + 1 }
        : undefined,
    );
  };

  const matchingPages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? graph.nodes.filter((node) =>
          [node.title, node.description, ...node.tags]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : graph.nodes;
  }, [graph, query]);

  return (
    <div className="wiki-graph-surface">
      <div className="wiki-graph-toolbar">
        <div
          aria-label="Timeline granularity"
          className="wiki-graph-segmented"
          role="radiogroup"
        >
          {(["day", "week"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={granularity === value}
              onClick={() => changeGranularity(value)}
            >
              {value === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <label className="wiki-graph-search">
          <Icon icon={Search01Icon} size={14} />
          <input
            aria-label="Search pages"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages"
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="wiki-graph-reading-row">
        {renderTimeline?.(matchingPages, granularity, {
          focus: cardFocus,
          onPeriodChange: followCard,
        }) ?? (
          <p className="p-6 text-sm text-app-muted">No reports available.</p>
        )}
        {dailyPanel}
      </div>

      <WikiGraphTimeline
        buckets={timeline.buckets}
        granularity={granularity}
        cursor={cursor}
        focused={focused}
        onCursorChange={pickDay}
        onSelect={pickDay}
        onShowAll={showAll}
      />
    </div>
  );
}
