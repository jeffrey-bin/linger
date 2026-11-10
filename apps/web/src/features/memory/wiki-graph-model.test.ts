import { describe, expect, it } from "vitest";

import {
  buildTimeline,
  nodeMoments,
  pageTitle,
  parseEmbeddedWikiGraph,
  type WikiGraphData,
  type WikiGraphNode,
} from "./wiki-graph-model";

function node(
  id: string,
  overrides: Partial<WikiGraphNode> = {},
): WikiGraphNode {
  return {
    id,
    title: id,
    category: "Topic",
    description: "",
    tags: [],
    body: "",
    size: 100,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

const graph: WikiGraphData = {
  types: ["Project", "Session", "Topic"],
  nodes: [
    node("sessions/2026-09-01/capture_session_a", {
      category: "Session",
      links: ["projects/lev8"],
    }),
    node("sessions/2026-09-03/capture_session_c", { category: "Session" }),
    node("projects/lev8", {
      category: "Project",
      backlinks: ["sessions/2026-09-01/capture_session_a"],
      body: "Kickoff on 2026-08-30. Revisited 2026-09-01. Not a day: 2026-02-31.",
    }),
    node("topics/undated"),
  ],
  edges: [
    {
      source: "sessions/2026-09-01/capture_session_a",
      target: "projects/lev8",
    },
  ],
  timelineEvents: [{ id: "one", day: "2026-08-30", title: "Kickoff" }],
};

describe("parseEmbeddedWikiGraph", () => {
  it("reads the graph the Memory visualization embeds", () => {
    const html = `<script>\nconst graph=${JSON.stringify(graph).replaceAll("<", "\\u003c")};\nconst input=1;</script>`;
    expect(parseEmbeddedWikiGraph(html)?.nodes.map((n) => n.id)).toEqual(
      graph.nodes.map((n) => n.id),
    );
  });

  it("returns undefined for HTML without an embedded graph", () => {
    expect(
      parseEmbeddedWikiGraph("<html><body>graph</body></html>"),
    ).toBeUndefined();
    expect(parseEmbeddedWikiGraph("const graph={broken;\n")).toBeUndefined();
  });
});

describe("nodeMoments", () => {
  const moments = nodeMoments(graph);

  it("uses Session dates and indexed events, not dates mentioned in Wiki prose", () => {
    expect(moments.get("sessions/2026-09-01/capture_session_a")).toEqual([
      { day: "2026-09-01", strength: "session" },
    ]);
    expect(moments.has("projects/lev8")).toBe(false);
    expect(moments.get("event:one")).toEqual([
      { day: "2026-08-30", strength: "event" },
    ]);
  });

  it("ignores impossible dates and leaves undated pages out", () => {
    expect(moments.has("projects/lev8")).toBe(false);
    expect(moments.has("topics/undated")).toBe(false);
  });
});

describe("buildTimeline", () => {
  const moments = nodeMoments(graph);

  it("keeps empty days between the first and last moment", () => {
    const timeline = buildTimeline(moments, "day", "2026-09-03");
    expect(timeline.buckets.map((b) => b.start)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    expect(timeline.buckets[2]!.counts).toEqual({
      session: 1,
      event: 0,
    });
    expect(timeline.buckets[0]!.monthLabel).toBe("Aug");
    expect(timeline.buckets[2]!.monthLabel).toBe("Sep");
    expect(timeline.buckets[1]!.monthLabel).toBeUndefined();
    expect(timeline.buckets.map((b) => b.yearLabel)).toEqual([
      "2026",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("groups by Monday-start weeks", () => {
    const timeline = buildTimeline(moments, "week", "2026-09-03");
    expect(timeline.buckets.map((b) => b.start)).toEqual([
      "2026-08-24",
      "2026-08-31",
    ]);
    expect(timeline.nodeBuckets.get("event:one")).toEqual([0]);
  });

  it("continues through today with empty buckets after the last update", () => {
    const daily = buildTimeline(moments, "day", "2026-09-06");
    expect(daily.buckets.map((b) => b.start).slice(-4)).toEqual([
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
    expect(daily.buckets.at(-1)!.counts).toEqual({
      session: 0,
      event: 0,
    });
    expect(daily.nodeBuckets.get("event:one")).toEqual([0]);
    expect(
      buildTimeline(moments, "week", "2026-09-08").buckets.map((b) => b.start),
    ).toEqual(["2026-08-24", "2026-08-31", "2026-09-07"]);
  });
});

describe("pageTitle and pageSummary", () => {
  it("drops the repeated date from Session titles", () => {
    expect(
      pageTitle(
        node("sessions/2026-08-25/capture_session_a", {
          title: "2026-08-25 Shisuo and JieLi hardware discussion",
        }),
      ),
    ).toBe("Shisuo and JieLi hardware discussion");
    expect(pageTitle(node("projects/lev8", { title: "Lev8 Outbound" }))).toBe(
      "Lev8 Outbound",
    );
  });
});
