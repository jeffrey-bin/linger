/** Keyword helpers shared by the global search dialog: one case-insensitive substring, no ranking. */

export function normalizeSearchQuery(raw: string) {
  return raw.trim().toLocaleLowerCase();
}

export function matchesSearchQuery(
  query: string,
  values: ReadonlyArray<string | null | undefined>,
) {
  if (!query) return false;
  return values.some((value) =>
    value ? value.toLocaleLowerCase().includes(query) : false,
  );
}

/**
 * The passage around the first match: `before` characters ahead of it and
 * `radius` after, so a narrow line can open close to the match and keep the
 * highlighted word in view.
 */
export function snippetAround(
  text: string,
  query: string,
  radius = 60,
  before = radius,
) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!query) return flat.slice(0, radius * 2);
  const index = flat.toLocaleLowerCase().indexOf(query);
  if (index < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, index - before);
  const end = Math.min(flat.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Compact relative age for result rows: 5m, 3h, 2d, then a short date. */
export function relativeTimeLabel(iso: string, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const elapsed = Math.max(0, now - time);
  const minute = 60_000;
  if (elapsed < minute) return "now";
  if (elapsed < 60 * minute) return `${Math.round(elapsed / minute)}m`;
  if (elapsed < 24 * 60 * minute)
    return `${Math.round(elapsed / (60 * minute))}h`;
  if (elapsed < 7 * 24 * 60 * minute) {
    return `${Math.round(elapsed / (24 * 60 * minute))}d`;
  }
  return new Date(time).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
