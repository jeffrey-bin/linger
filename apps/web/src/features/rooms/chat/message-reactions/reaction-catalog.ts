import { useEffect, useState } from "react";

interface EmojiMartData {
  categories: readonly { id: string; emojis: readonly string[] }[];
  emojis: Readonly<
    Record<
      string,
      {
        id: string;
        name: string;
        keywords: readonly string[];
        skins: readonly { native: string; unified: string }[];
      }
    >
  >;
}

/** One CLDR annotation from emojibase-data. */
export interface EmojiAnnotation {
  readonly hexcode: string;
  readonly label: string;
  readonly tags?: readonly string[];
}

export interface ReactionCatalogEntry {
  readonly id: string;
  readonly glyph: string;
  readonly name: string;
  readonly keywords: readonly string[];
}

export interface ReactionCatalogCategory {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly ReactionCatalogEntry[];
}

export interface ReactionCatalog {
  readonly categories: readonly ReactionCatalogCategory[];
  readonly recommended: readonly ReactionCatalogEntry[];
  readonly byId: ReadonlyMap<string, ReactionCatalogEntry>;
}

// The official library is every emoji of @emoji-mart/data 1.2.1 set 15
// (Unicode Emoji 15); TeamHub embeds the same IDs and rejects any other.
// Default quick Reactions, picked by product from the Agent auto-reaction set
// (apps/teamhub/internal/messageautoreaction/config.default.yaml).
export const RECOMMENDED_REACTION_IDS = [
  "heart",
  "ok_hand",
  "+1",
  "smile",
  "tada",
  "joy",
] as const;

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  people: "Smileys & People",
  nature: "Animals & Nature",
  foods: "Food & Drink",
  activity: "Activity",
  places: "Travel & Places",
  objects: "Objects",
  symbols: "Symbols",
  flags: "Flags",
};

// The emoji-mart dataset is English-only; CLDR Chinese annotations let
// Chinese-speaking users search Reactions too. The path stays a literal so the
// bundler emits one lazy chunk instead of one per emojibase locale.
const loadReactionAnnotationLocale = () =>
  import("emojibase-data/zh/compact.json");

// Both datasets spell the same code point sequence, but only emoji-mart keeps
// the FE0F variation selector and uses lowercase hex.
function codePointKey(sequence: string): string {
  return sequence
    .toUpperCase()
    .split("-")
    .filter((part) => part !== "FE0F")
    .join("-");
}

export function buildReactionCatalog(
  data: EmojiMartData,
  annotations: readonly EmojiAnnotation[],
): ReactionCatalog {
  const annotationsByKey = new Map(
    annotations.map((annotation) => [
      codePointKey(annotation.hexcode),
      annotation,
    ]),
  );
  const byId = new Map<string, ReactionCatalogEntry>();
  const categories = data.categories.map((category) => ({
    id: category.id,
    label: CATEGORY_LABELS[category.id] ?? category.id,
    entries: category.emojis.flatMap((id) => {
      const emoji = data.emojis[id];
      const skin = emoji?.skins[0];
      const glyph = skin?.native;
      if (!emoji || !skin || !glyph) return [];
      const annotation = annotationsByKey.get(codePointKey(skin.unified));
      const entry: ReactionCatalogEntry = {
        id,
        glyph,
        name: emoji.name,
        keywords: [
          ...new Set([
            ...emoji.keywords,
            ...(annotation
              ? [annotation.label, ...(annotation.tags ?? [])]
              : []),
          ]),
        ],
      };
      byId.set(id, entry);
      return [entry];
    }),
  }));
  return {
    byId,
    categories,
    recommended: RECOMMENDED_REACTION_IDS.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    }),
  };
}

let catalogPromise: Promise<ReactionCatalog> | undefined;
let loadedCatalog: ReactionCatalog | undefined;

/** Loads the emoji data on first use so it never joins the initial bundle. */
export function loadReactionCatalog(): Promise<ReactionCatalog> {
  catalogPromise ??= Promise.all([
    import("@emoji-mart/data/sets/15/native.json"),
    loadReactionAnnotationLocale(),
  ])
    .then(([data, annotations]) => {
      loadedCatalog = buildReactionCatalog(
        (data as { default: EmojiMartData }).default,
        (annotations as { default: readonly EmojiAnnotation[] }).default,
      );
      return loadedCatalog;
    })
    .catch((error: unknown) => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

export function useReactionCatalog(): ReactionCatalog | undefined {
  const [catalog, setCatalog] = useState(loadedCatalog);
  useEffect(() => {
    if (catalog) return;
    let active = true;
    void loadReactionCatalog()
      .then((loaded) => {
        if (active) setCatalog(loaded);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [catalog]);
  return catalog;
}

export function searchReactionCatalog(
  catalog: ReactionCatalog,
  query: string,
): ReactionCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const entries = catalog.categories.flatMap((category) => category.entries);
  if (!needle) return entries;
  return entries.filter(
    (entry) =>
      entry.name.toLocaleLowerCase().includes(needle) ||
      entry.id.includes(needle) ||
      entry.keywords.some((keyword) =>
        keyword.toLocaleLowerCase().includes(needle),
      ),
  );
}
