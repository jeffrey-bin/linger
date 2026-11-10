import {
  ENTITY_SECTIONS,
  SESSION_SECTIONS,
} from "@linger/knowledge-format/sections";
import type { WikiNode } from "openwiki/dist/visualize/graph.js";

/**
 * Edges the Memory service adds on top of OpenWiki's own link edges. OpenWiki
 * only knows the relative Markdown links a page happens to write; these record
 * that a page names a known entity. They live beside the native graph and
 * never change its nodes or edges.
 */
export interface InferredEdge {
  source: string;
  target: string;
  kind: "mention";
  /** Strength in 0-1, comparable across kinds. */
  weight: number;
  /** Mention: how often the name appears. */
  count: number;
  /** The newest Session date on either end, when one is known. */
  lastSeen?: string;
}

/** Pages with proper names that other pages can mention. */
const mentionTargetPrefixes = ["projects/", "clients/", "contacts/"] as const;
/** A one-word alias that reads as an ordinary word, not a coined name. */
const plainWordPattern = /^[A-Z]?[a-z]+$/u;
/**
 * Application-rendered H2 sections where a name is the subject of the page,
 * not a passing remark.
 */
const keySections = new Set<string>([
  SESSION_SECTIONS.decisionsAndOutcomes,
  SESSION_SECTIONS.actionItems,
  ENTITY_SECTIONS.projectSummary,
  ENTITY_SECTIONS.projectDirections,
]);
const hanPattern = /\p{Script=Han}/u;

/**
 * A page mentions an entity when its body names the entity's title or one
 * of its aliases exactly. Names shorter than 2 Han characters or 4 Latin
 * letters, plain one-word aliases ("Sequence"), and names shared by more than
 * one entity are not matched; a one-word Latin name must keep its capitals,
 * so "Epic" the client is not "an epic effort". Directory index pages neither
 * mention nor are mentioned. Each mention counts twice in a heading or in a
 * key section, an H2 whose text is exactly one of the rendered
 * `keySections`. The total is scaled by specificity (an IDF
 * over pages naming the entity), so an entity named on nearly every page
 * weighs little, then saturated into 0-1: one passing remark is about 0.3,
 * a typical mention about 0.5, and a page about the entity nears 1.
 */
export function mentionEdges(
  allNodes: readonly WikiNode[],
  aliasesById: ReadonlyMap<string, readonly string[]> = new Map(),
): InferredEdge[] {
  const nodes = allNodes.filter((node) => !isIndexPage(node.id));
  const names = entityNamePatterns(nodes, aliasesById);
  const raw = new Map<string, { weight: number; count: number }>();
  for (const node of nodes) {
    const sections = splitSections(node.body);
    for (const { target, pattern } of names) {
      if (target === node.id) continue;
      let weight = 0;
      let count = 0;
      for (const section of sections) {
        const hits = section.text.match(pattern)?.length ?? 0;
        if (!hits) continue;
        count += hits;
        weight += hits * (section.key ? 2 : 1);
      }
      if (!count) continue;
      const edgeKey = `${node.id}\n${target}`;
      const previous = raw.get(edgeKey);
      // A title and an alias of the same entity add up on one edge.
      raw.set(edgeKey, {
        weight: (previous?.weight ?? 0) + weight,
        count: (previous?.count ?? 0) + count,
      });
    }
  }

  const pagesNaming = new Map<string, number>();
  for (const edgeKey of raw.keys()) {
    const target = edgeKey.split("\n")[1]!;
    pagesNaming.set(target, (pagesNaming.get(target) ?? 0) + 1);
  }
  const total = nodes.length || 1;
  const dates = sessionDates(nodes);
  return [...raw].map(([edgeKey, value]) => {
    const [source, target] = edgeKey.split("\n") as [string, string];
    const specificity = Math.log(1 + total / (pagesNaming.get(target) ?? 1));
    return {
      source,
      target,
      kind: "mention" as const,
      weight: round(1 - Math.exp(-(value.weight * specificity) / 6)),
      count: value.count,
      ...lastSeen(dates, source, target),
    };
  });
}

/**
 * Whole-name patterns for the Projects, Clients, and Contacts other text can
 * name, under the same rules as mention edges; each pattern belongs to one
 * entity. Matches the names in a page body or in a conversation message.
 */
export function entityNamePatterns(
  nodes: readonly WikiNode[],
  aliasesById: ReadonlyMap<string, readonly string[]> = new Map(),
): Array<{ target: string; pattern: RegExp }> {
  const owners = new Map<string, { ids: Set<string>; name: string }>();
  for (const node of nodes) {
    if (!mentionTargetPrefixes.some((prefix) => node.id.startsWith(prefix)))
      continue;
    const aliases = (aliasesById.get(node.id) ?? []).filter(
      (alias) => !plainWordPattern.test(alias.trim()),
    );
    for (const name of [node.title, ...aliases]) {
      const key = normalizedName(name);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, { ids: new Set(), name });
      owners.get(key)!.ids.add(node.id);
    }
  }
  return [...owners.values()]
    .filter(({ ids }) => ids.size === 1)
    .map(({ ids, name }) => ({
      target: [...ids][0]!,
      pattern: namePattern(name.trim()),
    }));
}

/** The date of a dated Session page; other pages have none. */
export function sessionDate(id: string): string | undefined {
  return /^sessions\/(\d{4}-\d{2}-\d{2})\//u.exec(id)?.[1];
}

function normalizedName(name: string) {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  const cjk = hanPattern.test(key);
  if (cjk ? [...key].length < 2 : key.replace(/[^a-z0-9]/gu, "").length < 4)
    return undefined;
  return key;
}

function namePattern(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Han text has no word breaks. Latin names match whole words, and a
  // one-word name keeps its case so it is not read as a common word.
  if (hanPattern.test(name)) return new RegExp(escaped, "giu");
  const flags = /\s/u.test(name) ? "giu" : "gu";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags);
}

function isIndexPage(id: string) {
  return id === "index" || id.endsWith("/index");
}

function splitSections(body: string) {
  const sections: Array<{ key: boolean; text: string }> = [];
  let current = { key: false, text: "" };
  for (const line of body.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      sections.push(current);
      // A name in the heading itself is the section's subject.
      sections.push({ key: true, text: heading[1]! });
      current = {
        key: line.startsWith("## ") && keySections.has(heading[1]!.trim()),
        text: "",
      };
    } else current.text += `${line}\n`;
  }
  sections.push(current);
  return sections.filter((section) => section.text.trim());
}

function sessionDates(nodes: readonly WikiNode[]) {
  const dates = new Map<string, string>();
  for (const node of nodes) {
    const date = sessionDate(node.id);
    if (date) dates.set(node.id, date);
  }
  return dates;
}

function lastSeen(
  dates: ReadonlyMap<string, string>,
  source: string,
  target: string,
) {
  const known = [dates.get(source), dates.get(target)].filter(
    (date): date is string => Boolean(date),
  );
  return known.length ? { lastSeen: known.sort().at(-1)! } : {};
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
