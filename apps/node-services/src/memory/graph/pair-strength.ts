import type { StoredWikiGraph } from "./build.js";

/**
 * How strongly two pages are tied, from every edge between them. A pair's
 * strength is its strongest piece of evidence: a native link counts 0.5, and
 * mention edges count their own 0-1 weight. Taking the maximum
 * separated strong from weak ties better than combining evidence on labelled
 * local pairs, because native links often join loosely related Topics.
 */
export const NATIVE_LINK_STRENGTH = 0.5;

export type TieKind = "link" | "mention";

export interface PairTie {
  strength: number;
  kinds: TieKind[];
  /** Each kind's own strength; a link counts the native link strength. */
  weights: Partial<Record<TieKind, number>>;
}

/** Each page's tied pages, in both directions. */
export function pairTies(
  graph: StoredWikiGraph,
  nativeLinkStrength = NATIVE_LINK_STRENGTH,
): Map<string, Map<string, PairTie>> {
  const ties = new Map<string, Map<string, PairTie>>();
  const tie = (a: string, b: string) => {
    if (!ties.has(a)) ties.set(a, new Map());
    const row = ties.get(a)!;
    if (!row.has(b)) row.set(b, { strength: 0, kinds: [], weights: {} });
    return row.get(b)!;
  };
  const add = (
    source: string,
    target: string,
    update: (value: PairTie) => void,
  ) => {
    if (source === target) return;
    update(tie(source, target));
    update(tie(target, source));
  };
  for (const edge of graph.edges)
    add(edge.source, edge.target, (value) => {
      if (!value.kinds.includes("link")) value.kinds.push("link");
      value.weights.link = nativeLinkStrength;
      value.strength = Math.max(value.strength, nativeLinkStrength);
    });
  for (const edge of graph.inferredEdges ?? [])
    add(edge.source, edge.target, (value) => {
      if (!value.kinds.includes(edge.kind)) value.kinds.push(edge.kind);
      value.weights[edge.kind] = Math.max(
        value.weights[edge.kind] ?? 0,
        edge.weight,
      );
      value.strength = Math.max(value.strength, edge.weight);
    });
  return ties;
}
