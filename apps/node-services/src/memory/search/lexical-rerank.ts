/** Extra lexical candidates read so the rerank can promote better covered ones. */
export const LEXICAL_RERANK_POOL_FACTOR = 4;

/**
 * Lexical candidate order borrowed from OpenWiki's wiki retrieval: candidates
 * matching more distinct query terms rank first, in quarter buckets so that
 * the many overlapping Han bigrams of one query cannot dominate; within a
 * bucket the lexical score is boosted by the query terms found in the title.
 * The sort is stable, so equal candidates keep the database order.
 */
export function rerankLexicalCandidates<T>(
  rows: readonly T[],
  terms: readonly string[],
  fields: {
    matchedTerms: (row: T) => number;
    titleTerms: (row: T) => readonly string[];
    score: (row: T) => number;
  },
  limit: number,
): T[] {
  const unique = new Set(terms);
  if (unique.size === 0) return rows.slice(0, limit);
  const keyed = rows.map((row) => {
    const coverage = Math.min(1, fields.matchedTerms(row) / unique.size);
    const titleHits = new Set(
      fields.titleTerms(row).filter((term) => unique.has(term)),
    ).size;
    return {
      row,
      bucket: Math.floor(coverage * 4),
      score: fields.score(row) * (1 + titleHits / unique.size),
    };
  });
  keyed.sort((a, b) => b.bucket - a.bucket || b.score - a.score);
  return keyed.slice(0, limit).map(({ row }) => row);
}
