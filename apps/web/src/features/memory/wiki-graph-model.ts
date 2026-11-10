import { dayKey, formatDateTime } from "@/lib/date-format";

export interface WikiGraphNode {
  id: string;
  title: string;
  category: string;
  description: string;
  tags: string[];
  body: string;
  size: number;
  links: string[];
  backlinks: string[];
}

export interface WikiGraphEdge {
  source: string;
  target: string;
  /** Inferred by Memory: the page names the entity. Absent when the pair has
   * a native OpenWiki link. */
  kind?: "mention";
  /** The pair's strength in 0-1, from its strongest tie. */
  strength?: number;
  /** Every tie between the two pages, and each tie's own strength. */
  kinds?: ReadonlyArray<"link" | "mention">;
  weights?: Partial<Record<"link" | "mention", number>>;
}

export interface WikiGraphData {
  types: string[];
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  timelineEvents?: TimelineEvent[];
}

export interface TimelineEvent {
  id: string;
  day: string;
  title: string;
}

export const TIMELINE_EVENT_PREFIX = "event:";

/** A dated Session or an indexed event. */
export type MomentStrength = "session" | "event";

export interface NodeMoment {
  day: string;
  strength: MomentStrength;
}

export type TimeGranularity = "day" | "week";

export interface TimeBucket {
  start: string;
  monthLabel?: string;
  /** Set on the first bucket and wherever a new year begins. */
  yearLabel?: string;
  counts: Record<MomentStrength, number>;
}

export interface WikiTimeline {
  buckets: TimeBucket[];
  /** Bucket indices of each node's moments; undated nodes are absent. */
  nodeBuckets: Map<string, number[]>;
}

const SESSION_DAY = /^sessions\/(\d{4}-\d{2}-\d{2})\//u;
const DAY_MS = 86_400_000;

/**
 * Read the graph the Memory visualization embeds as `const graph={...};`.
 * Temporary until TeamHub serves the graph as JSON; any other shape falls back
 * to the original HTML view.
 */
export function parseEmbeddedWikiGraph(
  html: string,
): WikiGraphData | undefined {
  const match = /const graph=(\{[\s\S]*?\});\n/u.exec(html);
  if (!match?.[1]) return undefined;
  try {
    const value = JSON.parse(match[1]) as Partial<WikiGraphData>;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges))
      return undefined;
    return {
      types: Array.isArray(value.types) ? value.types : [],
      nodes: value.nodes.map((node) => ({
        ...node,
        tags: node.tags ?? [],
        body: node.body ?? "",
        description: node.description ?? "",
        links: node.links ?? [],
        backlinks: node.backlinks ?? [],
      })),
      edges: value.edges,
      timelineEvents: Array.isArray(value.timelineEvents)
        ? value.timelineEvents
        : [],
    };
  } catch {
    return undefined;
  }
}

export function nodeMoments(graph: WikiGraphData): Map<string, NodeMoment[]> {
  const sessionDay = new Map<string, string>();
  for (const node of graph.nodes) {
    const day = SESSION_DAY.exec(node.id)?.[1];
    if (day && isCalendarDay(day)) sessionDay.set(node.id, day);
  }
  const result = new Map<string, NodeMoment[]>();
  for (const node of graph.nodes) {
    const own = sessionDay.get(node.id);
    if (own) result.set(node.id, [{ day: own, strength: "session" }]);
  }
  for (const event of graph.timelineEvents ?? []) {
    if (isCalendarDay(event.day))
      result.set(`${TIMELINE_EVENT_PREFIX}${event.id}`, [
        { day: event.day, strength: "event" },
      ]);
  }
  return result;
}

/**
 * Contiguous buckets from the first moment through today, so quiet days, and
 * the days since the last update, stay visible as empty buckets.
 */
export function buildTimeline(
  moments: Map<string, NodeMoment[]>,
  granularity: TimeGranularity,
  today = dayKey(new Date()),
): WikiTimeline {
  const days = [...moments.values()]
    .flat()
    .map((moment) => moment.day)
    .sort();
  if (!days.length) return { buckets: [], nodeBuckets: new Map() };
  const first = bucketStart(days[0]!, granularity);
  const lastDay = days.at(-1)! > today ? days.at(-1)! : today;
  const last = bucketStart(lastDay, granularity);
  const step = granularity === "day" ? 1 : 7;
  const buckets: TimeBucket[] = [];
  const indexByStart = new Map<string, number>();
  for (
    let time = dayTime(first);
    time <= dayTime(last);
    time += step * DAY_MS
  ) {
    const start = dayString(time);
    const previous = buckets.at(-1)?.start;
    indexByStart.set(start, buckets.length);
    buckets.push({
      start,
      ...(previous === undefined || previous.slice(0, 7) !== start.slice(0, 7)
        ? { monthLabel: monthLabel(start) }
        : {}),
      ...(previous === undefined || previous.slice(0, 4) !== start.slice(0, 4)
        ? { yearLabel: start.slice(0, 4) }
        : {}),
      counts: { session: 0, event: 0 },
    });
  }
  const nodeBuckets = new Map<string, number[]>();
  for (const [id, list] of moments) {
    const indices = new Set<number>();
    for (const moment of list) {
      const index = indexByStart.get(bucketStart(moment.day, granularity))!;
      indices.add(index);
      buckets[index]!.counts[moment.strength] += 1;
    }
    nodeBuckets.set(
      id,
      [...indices].sort((a, b) => a - b),
    );
  }
  return { buckets, nodeBuckets };
}

export function bucketStart(day: string, granularity: TimeGranularity): string {
  if (granularity === "day") return day;
  const time = dayTime(day);
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday = 0
  return dayString(time - weekday * DAY_MS);
}

function monthLabel(start: string): string {
  return formatDateTime(dayTime(start), {
    month: "short",
    timeZone: "UTC",
  });
}

function isCalendarDay(day: string): boolean {
  const time = dayTime(day);
  return Number.isFinite(time) && dayString(time) === day;
}

function dayTime(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function dayString(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

const LEADING_DAY = /^\d{4}-\d{2}-\d{2}\s+/u;

/** Session titles repeat their date; the date is shown separately. */
export function pageTitle(node: WikiGraphNode): string {
  return node.title.replace(LEADING_DAY, "") || node.title;
}
