import type { ParseError } from "papaparse";

export function firstFatalDataPreviewError(
  errors: ParseError[],
  sourceTruncated: boolean,
) {
  return errors.find(
    (error) =>
      error.code !== "UndetectableDelimiter" &&
      error.code !== "TooFewFields" &&
      !(sourceTruncated && error.code === "MissingQuotes"),
  );
}

export function completeRowsInDataPreviewChunk<T>(
  rows: T[],
  errors: ParseError[],
  sourceTruncated: boolean,
) {
  if (
    sourceTruncated &&
    rows.length > 0 &&
    errors.some((error) => error.code === "MissingQuotes")
  ) {
    return {
      incompleteQuotedRecordRemoved: true,
      rows: rows.slice(0, -1),
    };
  }

  return { incompleteQuotedRecordRemoved: false, rows };
}

export function endsAtRecordBoundary(tail: string) {
  return tail.endsWith("\n") || tail.endsWith("\r");
}
