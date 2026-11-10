/** Candidates each retrieval branch contributes before fusion. */
export const HYBRID_SEARCH_CANDIDATES = 50;
export const RRF_K = 60;

/** Reciprocal-rank fusion of any number of ranked lists; ties order by `key`. */
export function fuseRankedLists<T>(
  lists: readonly (readonly T[])[],
  key: (candidate: T) => string,
): { candidate: T; rrfScore: number }[] {
  const combined = new Map<string, { candidate: T; rrfScore: number }>();
  for (const list of lists)
    for (const [index, candidate] of list.entries()) {
      const current = combined.get(key(candidate));
      if (current) current.rrfScore += 1 / (RRF_K + index + 1);
      else
        combined.set(key(candidate), {
          candidate,
          rrfScore: 1 / (RRF_K + index + 1),
        });
    }
  return [...combined.values()].sort(
    (left, right) =>
      right.rrfScore - left.rrfScore ||
      key(left.candidate).localeCompare(key(right.candidate)),
  );
}
