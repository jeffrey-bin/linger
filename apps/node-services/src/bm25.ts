/** Okapi BM25 with Lucene's non-negative Robertson IDF. No field boosts. */
export function searchBm25<T>(
  documents: readonly { value: T; text: string }[],
  query: string,
): Array<{ value: T; score: number; coverage: number }> {
  const terms = [...new Set(tokenizeSearchText(query))];
  if (terms.length === 0 || documents.length === 0) return [];
  const prepared = documents.map((document) => {
    const tokens = tokenizeSearchText(document.text);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { ...document, frequencies, length: tokens.length };
  });
  const averageLength =
    prepared.reduce((sum, document) => sum + document.length, 0) /
    prepared.length;
  if (averageLength === 0) return [];
  const idfs = new Map(
    terms.map((term) => {
      const frequency = prepared.filter(({ frequencies }) =>
        frequencies.has(term),
      ).length;
      return [
        term,
        Math.log(1 + (prepared.length - frequency + 0.5) / (frequency + 0.5)),
      ];
    }),
  );
  return prepared
    .map(({ value, frequencies, length }) => {
      let score = 0;
      let matches = 0;
      for (const term of terms) {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) continue;
        matches += 1;
        score +=
          (idfs.get(term)! * (frequency * 2.2)) /
          (frequency + 1.2 * (1 - 0.75 + (0.75 * length) / averageLength));
      }
      return { value, score, coverage: matches / terms.length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}

/** One analyzer for query and corpus; preserve the existing mixed Han/Latin behavior. */
export function tokenizeSearchText(value: string): string[] {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/([\p{Script=Han}])([\p{Script=Latin}\p{N}_])/gu, "$1 $2")
    .replace(/([\p{Script=Latin}\p{N}_])([\p{Script=Han}])/gu, "$1 $2");
  const tokens = normalized.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...sequence];
    for (let i = 0; i + 1 < characters.length; i += 1) {
      tokens.push(`${characters[i]}${characters[i + 1]}`);
    }
  }
  return tokens;
}
