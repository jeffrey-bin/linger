import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import {
  isWikiCollection,
  wikiPageKey,
  wikiPagePath,
  type WikiCollection,
} from "./wiki-display-state";

/**
 * A page the running refresh has written but not published yet. It is shown
 * in its collection beside the published pages; it is not a Document.
 */
export interface WikiPreviewPage {
  path: string;
  key: string;
  collection: WikiCollection;
  name: string;
  description: string;
  markdown: string;
}

/** One card of a collection: a published page, or a page being generated. */
export type WikiEntry =
  | { key: string; published: TeamHubDocument; preview?: undefined }
  | { key: string; preview: WikiPreviewPage; published?: undefined };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** The page's title and description: generated pages carry JSON frontmatter. */
function pageFields(markdown: string): {
  title?: string;
  description?: string;
} {
  const raw = FRONTMATTER.exec(markdown)?.[1];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { title, description } = parsed as Record<string, unknown>;
      return {
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof description === "string" ? { description } : {}),
      };
    }
  } catch {
    // YAML frontmatter: read the two plain fields.
  }
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "mu")
      .exec(raw)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/u, "$2");
  const title = field("title");
  const description = field("description");
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

/** The preview's collection pages; navigation and Session pages are left out. */
export function wikiPreviewPages(
  preview: Record<string, string> | undefined,
): WikiPreviewPage[] {
  return Object.entries(preview ?? {})
    .flatMap(([path, markdown]) => {
      const segments = path.replace(/^\/+/u, "").split("/");
      const [collection] = segments;
      const file = segments.at(-1) ?? "";
      if (
        segments.length < 2 ||
        !collection ||
        !isWikiCollection(collection) ||
        /^index\.md$/iu.test(file)
      )
        return [];
      const fields = pageFields(markdown);
      const name =
        fields.title?.trim() ||
        /^# (.+)$/mu.exec(markdown)?.[1]?.trim() ||
        file.replace(/\.md$/iu, "");
      return [
        {
          path,
          key: wikiPageKey(path),
          collection,
          name,
          description: fields.description?.trim() ?? "",
          markdown,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A collection's cards: the pages being generated first, then the published
 * pages they do not replace.
 */
export function wikiEntries(
  published: readonly TeamHubDocument[],
  previews: readonly WikiPreviewPage[],
  collection: WikiCollection,
): WikiEntry[] {
  const updating = previews.filter((page) => page.collection === collection);
  const keys = new Set(updating.map((page) => page.key));
  return [
    ...updating.map((page) => ({ key: page.key, preview: page })),
    ...published.flatMap((page) => {
      const key = wikiPageKey(wikiPagePath(page));
      return keys.has(key) ? [] : [{ key, published: page }];
    }),
  ];
}
