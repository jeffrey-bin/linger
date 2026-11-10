import { describe, expect, it } from "vitest";

import { rerankLexicalCandidates } from "../../src/memory/search/lexical-rerank.js";

interface Row {
  id: string;
  matched: number;
  title: string[];
  score: number;
}
const fields = {
  matchedTerms: (row: Row) => row.matched,
  titleTerms: (row: Row) => row.title,
  score: (row: Row) => row.score,
};

describe("lexical candidate rerank", () => {
  it("ranks candidates covering more query terms above a higher repeated-term score", () => {
    const rows: Row[] = [
      { id: "repeats-acme", matched: 1, title: [], score: 0.9 },
      { id: "acme-budget", matched: 2, title: [], score: 0.2 },
    ];
    expect(
      rerankLexicalCandidates(rows, ["acme", "budget"], fields, 10).map(
        ({ id }) => id,
      ),
    ).toEqual(["acme-budget", "repeats-acme"]);
  });

  it("boosts title matches within the same coverage bucket", () => {
    const rows: Row[] = [
      { id: "body", matched: 2, title: ["notes"], score: 0.5 },
      { id: "titled", matched: 2, title: ["acme"], score: 0.4 },
    ];
    expect(
      rerankLexicalCandidates(rows, ["acme", "budget"], fields, 10).map(
        ({ id }) => id,
      ),
    ).toEqual(["titled", "body"]);
  });

  it("buckets coverage so near-equal coverage keeps the score order, and trims to the limit", () => {
    const terms = Array.from({ length: 8 }, (_, index) => `t${index}`);
    const rows: Row[] = [
      { id: "five", matched: 5, title: [], score: 0.9 },
      { id: "four", matched: 4, title: [], score: 0.1 },
      { id: "one", matched: 1, title: [], score: 1 },
    ];
    expect(
      rerankLexicalCandidates(rows, terms, fields, 2).map(({ id }) => id),
    ).toEqual(["five", "four"]);
  });

  it("keeps the database order without query terms", () => {
    const rows: Row[] = [
      { id: "a", matched: 0, title: [], score: 0.1 },
      { id: "b", matched: 0, title: [], score: 0.9 },
    ];
    expect(
      rerankLexicalCandidates(rows, [], fields, 10).map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });
});
