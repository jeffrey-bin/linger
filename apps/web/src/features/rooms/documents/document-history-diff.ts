export type DocumentHistoryDiffLine =
  | { id: string; kind: "add"; text: string }
  | { id: string; kind: "equal"; text: string }
  | { id: string; kind: "remove"; text: string };

/**
 * Line-oriented diff between two Markdown snapshots. Removed lines exist only
 * in the older snapshot; added lines exist only in the newer one. The result
 * keeps stable context so the history modal can highlight what changed.
 */
export function diffDocumentLines(
  older: string,
  newer: string,
): DocumentHistoryDiffLine[] {
  const left = splitLines(older);
  const right = splitLines(newer);
  if (left.length === 0 && right.length === 0) {
    return [];
  }
  return walkDiff(lcsMatrix(left, right), left, right);
}

function splitLines(markdown: string): string[] {
  if (markdown.length === 0) {
    return [];
  }
  const lines = markdown.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function lcsMatrix(left: string[], right: string[]) {
  const matrix: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      matrix[i]![j] =
        left[i] === right[j]
          ? (matrix[i + 1]![j + 1] ?? 0) + 1
          : Math.max(matrix[i + 1]![j] ?? 0, matrix[i]![j + 1] ?? 0);
    }
  }
  return matrix;
}

function walkDiff(
  matrix: number[][],
  left: string[],
  right: string[],
): DocumentHistoryDiffLine[] {
  const result: DocumentHistoryDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ id: `equal:${i}:${j}`, kind: "equal", text: left[i]! });
      i += 1;
      j += 1;
    } else if ((matrix[i + 1]?.[j] ?? 0) >= (matrix[i]?.[j + 1] ?? 0)) {
      result.push({ id: `remove:${i}`, kind: "remove", text: left[i]! });
      i += 1;
    } else {
      result.push({ id: `add:${j}`, kind: "add", text: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) {
    result.push({ id: `remove:${i}`, kind: "remove", text: left[i]! });
    i += 1;
  }
  while (j < right.length) {
    result.push({ id: `add:${j}`, kind: "add", text: right[j]! });
    j += 1;
  }
  return result;
}
