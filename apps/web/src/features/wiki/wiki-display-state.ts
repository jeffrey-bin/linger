import { useQuery } from "@tanstack/react-query";
import { useLibraryTreeState } from "@/features/library/use-library-tree-state";
import { teamHubIdentityQueryOptions } from "@/features/rooms/room-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import type { WikiGraphData } from "@/features/memory/wiki-graph-model";

export const wikiCollectionLabels = {
  projects: "Projects",
  topics: "Topics",
  contacts: "People",
  clients: "Companies",
} as const;
export type WikiCollection = keyof typeof wikiCollectionLabels;
export function isWikiCollection(value: string): value is WikiCollection {
  return Object.hasOwn(wikiCollectionLabels, value);
}
export function wikiPagePath(document: TeamHubDocument) {
  return (
    document.from.find((source) => source.binding_kind === "wiki_page")
      ?.page_key ?? document.title
  );
}
export function wikiPageKey(path: string) {
  return path
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "")
    .replace(/\/index$/i, "");
}
export function wikiCollection(
  document: TeamHubDocument,
): WikiCollection | null {
  const first = wikiPagePath(document).replace(/^\/+/, "").split("/")[0];
  return first && isWikiCollection(first) ? first : null;
}
export type WikiDisplayDecisions = Record<string, "keep" | "delete">;
export function useWikiDisplayState(tenantId: string) {
  const { client } = useTeamHubRuntime();
  const identity = useQuery(teamHubIdentityQueryOptions(client));
  const accountId = identity.data?.account.id;
  const key = `linger:wiki-display:v1:${tenantId}:${accountId ?? "pending"}`;
  const [decisions, setDecisions] = useLibraryTreeState<WikiDisplayDecisions>(
    tenantId,
    key,
    () => {
      try {
        const value: unknown = JSON.parse(
          window.localStorage.getItem(key) ?? "{}",
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          return {};
        return Object.fromEntries(
          Object.entries(value).filter(
            ([, choice]) => choice === "keep" || choice === "delete",
          ),
        );
      } catch {
        return {};
      }
    },
  );
  return {
    decisions,
    ready: Boolean(accountId),
    decide(path: string, choice: "keep" | "delete") {
      if (!accountId) return;
      const next = { ...decisions, [wikiPageKey(path)]: choice };
      setDecisions(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Keep session state when browser storage is unavailable. */
      }
    },
  };
}
export function filterWikiGraph(
  graph: WikiGraphData,
  decisions: WikiDisplayDecisions,
): WikiGraphData {
  const visible = (id: string) => decisions[wikiPageKey(id)] !== "delete";
  const nodes = graph.nodes
    .filter((node) => visible(node.id))
    .map((node) => ({
      ...node,
      links: node.links.filter(visible),
      backlinks: node.backlinks.filter(visible),
    }));
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    edges: graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
  };
}
