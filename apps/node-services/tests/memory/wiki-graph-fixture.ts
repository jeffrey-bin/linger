import type { WikiGraph, WikiNode } from "openwiki/dist/visualize/graph.js";

export function wikiNode(id: string, fields: Partial<WikiNode> = {}): WikiNode {
  return {
    id,
    title: id,
    type: "Reference",
    description: "",
    body: "",
    tags: [],
    size: 0,
    links: [],
    backlinks: [],
    ...fields,
  };
}
export function wikiGraph(
  nodes: WikiNode[] = [],
  edges: WikiGraph["edges"] = [],
): WikiGraph {
  return {
    root: "wiki",
    generatedAt: "2026-09-29T00:00:00Z",
    types: [...new Set(nodes.map((node) => node.type))],
    nodes,
    edges,
  };
}
