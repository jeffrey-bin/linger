import path from "node:path";
import {
  firstHeading,
  splitFrontmatter,
  type WikiEdge,
  type WikiGraph,
  type WikiNode,
} from "openwiki/dist/visualize/graph.js";
import { mentionEdges, type InferredEdge } from "./inferred-edges.js";

// Revision is publication metadata, not a second graph model. All nodes and
// edges are the unmodified OpenWiki types. Memory's own mention edges sit
// beside them in `inferredEdges`, so every reader of `edges` sees exactly
// OpenWiki's link graph.
export type StoredWikiGraph = WikiGraph & {
  wikiRevision?: string;
  inferredEdges?: InferredEdge[];
};

/** One published Wiki page as the Wiki index stores it. */
export interface WikiPageContent {
  /** The page path, such as `projects/atlas.md`. */
  key: string;
  content: string;
}

const MARKDOWN_LINK = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/gu;

/**
 * Builds the knowledge graph of one published Wiki revision when it is read:
 * OpenWiki's page and link graph, the frontmatter aliases of the pages others
 * can name, and the inferred mention edges. Nothing is stored.
 */
export function buildWikiGraph(
  pages: readonly WikiPageContent[],
  wikiRevision: string,
): { graph: StoredWikiGraph; aliases: Map<string, string[]> } {
  const nodes = withoutPeriodReports(
    [...pages]
      .filter((page) => page.key.endsWith(".md"))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(readNode),
  );
  const edges = linkNodes(nodes);
  const aliases = new Map<string, string[]>();
  for (const page of pages) {
    const id = page.key.replace(/\.md$/u, "");
    if (!/^(projects|clients|contacts)\//u.test(id)) continue;
    const names = frontmatterAliases(page.content);
    if (names.length) aliases.set(id, names);
  }
  return {
    graph: {
      root: "wiki",
      generatedAt: new Date().toISOString(),
      types: [...new Set(nodes.map((node) => node.type))].sort(),
      nodes,
      edges,
      wikiRevision,
      inferredEdges: mentionEdges(nodes, aliases),
    },
    aliases,
  };
}

/** The same node OpenWiki builds from a page file. */
function readNode(page: WikiPageContent): WikiNode {
  const { meta, body } = splitFrontmatter(page.content);
  const scalar = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  const isIndex = path.posix.basename(page.key) === "index.md";
  const directory = path.posix.dirname(page.key);
  const section = directory === "." ? "Home" : path.posix.basename(directory);
  const title =
    scalar(meta.title) ??
    (isIndex
      ? section.charAt(0).toUpperCase() + section.slice(1)
      : firstHeading(body)) ??
    path.posix.basename(page.key, ".md");
  return {
    id: page.key.replace(/\.md$/u, ""),
    title,
    type: scalar(meta.type) ?? (isIndex ? "Section" : "Reference"),
    description: scalar(meta.description) ?? "",
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    body,
    size: body.length,
    links: [],
    backlinks: [],
  };
}

/**
 * Resolves each page's relative Markdown links into directed edges between
 * existing pages, as OpenWiki does; self-links, unknown targets and duplicate
 * edges are dropped.
 */
function linkNodes(nodes: WikiNode[]): WikiEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: WikiEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const directory = path.posix.dirname(`${node.id}.md`);
    for (const match of node.body.matchAll(MARKDOWN_LINK)) {
      const target = path.posix
        .normalize(path.posix.join(directory, match[1]!))
        .replace(/\.md$/u, "");
      const key = `${node.id}\n${target}`;
      const targetNode = byId.get(target);
      if (!targetNode || target === node.id || seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: node.id, target });
      node.links.push(target);
      targetNode.backlinks.push(node.id);
    }
  }
  return edges;
}

function frontmatterAliases(raw: string): string[] {
  if (!raw.startsWith("---")) return [];
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return [];
  const block = raw.slice(3, end).trim();
  try {
    const meta = JSON.parse(block) as { aliases?: unknown };
    return Array.isArray(meta.aliases)
      ? meta.aliases.filter(
          (alias): alias is string => typeof alias === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function withoutPeriodReports(nodes: WikiNode[]): WikiNode[] {
  return nodes.filter(
    (node) =>
      !node.id.startsWith("me/daily/") &&
      !node.id.startsWith("me/weekly/") &&
      node.id !== "me/daily" &&
      node.id !== "me/weekly" &&
      node.id !== "me/index" &&
      node.id !== "me",
  );
}
