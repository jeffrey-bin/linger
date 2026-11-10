import { describe, expect, it } from "vitest";
import { renderGraphVisualization } from "../../src/memory/graph/visualize.js";
import { wikiGraph, wikiNode } from "./wiki-graph-fixture.js";
describe("native Wiki graph visualization", () => {
  it("embeds native nodes and edges and escapes script-breaking content", () => {
    const graph = wikiGraph([
      wikiNode("topics/a", {
        title: "</script><script>bad()</script>",
        type: "Topic",
        body: "private body",
      }),
    ]);
    graph.root = "internal-agent";
    const html = renderGraphVisualization(graph, { embedded: true });
    expect(html).not.toContain("</script><script>bad()");
    expect(html).not.toContain('"root":"internal-agent"');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("node.body");
    expect(html).not.toContain("subjectKey");
    expect(html).not.toContain("similar_to");
    expect(html).toContain('aria-label="Node type filters"');
    expect(html).toContain("checkbox.checked=true");
    expect(html).toContain('"Topic":"#8b5cf6"');
  });
  it("omits the view-reset control and handler while retaining zoom and pan", () => {
    const html = renderGraphVisualization(wikiGraph([wikiNode("topics/a")]));
    expect(html).not.toContain("Reset view");
    expect(html).not.toContain('id="reset"');
    expect(html).not.toContain("querySelector('#reset')");
    expect(html).toContain("d3.zoom().scaleExtent([.15,4])");
    expect(html).toContain("svg.call(zoom)");
    expect(html).toContain('aria-label="Search graph"');
    expect(html).toContain('aria-label="Node type filters"');
  });
  it("embeds indexed timeline events with script-safe titles", () => {
    const html = renderGraphVisualization(wikiGraph([wikiNode("topics/a")]), {
      events: [{ id: "one", day: "2026-09-01", title: "</script>Event" }],
    });
    expect(html).toContain(
      '"timelineEvents":[{"id":"one","day":"2026-09-01","title":"\\u003c/script>Event"}]',
    );
    expect(html).not.toContain("</script>Event");
  });
  it("uses native directed source and target fields", () => {
    const graph = wikiGraph(
      [wikiNode("a"), wikiNode("b")],
      [{ source: "a", target: "b" }],
    );
    expect(renderGraphVisualization(graph)).toContain(
      '"edges":[{"source":"a","target":"b","strength":0.5,"kinds":["link"],"weights":{"link":0.5}}]',
    );
  });
  it("draws one edge per pair carrying every tie between the pages", () => {
    const graph = {
      ...wikiGraph(
        [wikiNode("a"), wikiNode("b"), wikiNode("c")],
        [{ source: "a", target: "b" }],
      ),
      inferredEdges: [
        {
          source: "b",
          target: "a",
          kind: "mention" as const,
          weight: 0.7,
          count: 1,
        },
        {
          source: "a",
          target: "c",
          kind: "mention" as const,
          weight: 0.4,
          count: 1,
        },
        {
          source: "c",
          target: "a",
          kind: "mention" as const,
          weight: 0.9,
          count: 1,
        },
      ],
    };
    expect(renderGraphVisualization(graph)).toContain(
      '"edges":[' +
        '{"source":"a","target":"b","strength":0.7,"kinds":["link","mention"],"weights":{"link":0.5,"mention":0.7}},' +
        '{"source":"a","target":"c","kind":"mention","strength":0.9,"kinds":["mention"],"weights":{"mention":0.9}}]',
    );
  });
});
