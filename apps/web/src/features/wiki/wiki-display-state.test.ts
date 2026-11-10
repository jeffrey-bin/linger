import { describe, expect, it } from "vitest";
import { filterWikiGraph } from "./wiki-display-state";
import {
  nodeMoments,
  type WikiGraphData,
  type WikiGraphNode,
} from "@/features/memory/wiki-graph-model";

function node(
  id: string,
  category = "Project",
  links: string[] = [],
  backlinks: string[] = [],
): WikiGraphNode {
  return {
    id,
    category,
    title: id,
    links,
    backlinks,
    body: "",
    description: "",
    tags: [],
    size: 1,
  };
}
const meeting = "sessions/2026-09-24/capture_session_meeting";

describe("Wiki display decisions", () => {
  it("hides deleted pages with their edges and links and keeps the source graph intact", () => {
    const graph: WikiGraphData = {
      types: ["Project", "Contact", "Session"],
      nodes: [
        node(meeting, "Session", ["projects/a", "contacts/b"]),
        node("projects/a", "Project", [], [meeting]),
        node("contacts/b", "Contact", [], [meeting]),
      ],
      edges: [
        { source: meeting, target: "projects/a" },
        { source: meeting, target: "contacts/b" },
      ],
    };
    const snapshot = structuredClone(graph);
    const shown = filterWikiGraph(graph, { "contacts/b": "delete" });
    expect(shown.nodes.map((n) => n.id)).toEqual([meeting, "projects/a"]);
    expect(shown.nodes.find((n) => n.id === meeting)?.links).toEqual([
      "projects/a",
    ]);
    expect(shown.edges).toEqual([{ source: meeting, target: "projects/a" }]);
    expect(nodeMoments(shown).has("projects/a")).toBe(false);
    expect(nodeMoments(shown).get(meeting)).toEqual([
      { day: "2026-09-24", strength: "session" },
    ]);
    expect(graph).toEqual(snapshot);
  });
});
