import { describe, expect, it } from "vitest";

import {
  completeRowsInDataPreviewChunk,
  endsAtRecordBoundary,
  firstFatalDataPreviewError,
} from "./data-preview-truncation";

describe("Data preview truncation", () => {
  it("treats a missing closing quote at the Range boundary as truncation", () => {
    expect(
      firstFatalDataPreviewError(
        [
          {
            code: "MissingQuotes",
            message: "Quoted field unterminated",
            row: 4,
            type: "Quotes",
          },
        ],
        true,
      ),
    ).toBeUndefined();
  });

  it("keeps missing quotes fatal for a complete source", () => {
    expect(
      firstFatalDataPreviewError(
        [
          {
            code: "MissingQuotes",
            message: "Quoted field unterminated",
            row: 4,
            type: "Quotes",
          },
        ],
        false,
      )?.code,
    ).toBe("MissingQuotes");
  });

  it("removes a partial quoted record even when its field contains a newline", () => {
    const result = completeRowsInDataPreviewChunk(
      [
        ["complete", "row"],
        ["partial\nquoted field", "without a closing quote"],
      ],
      [
        {
          code: "MissingQuotes",
          message: "Quoted field unterminated",
          row: 1,
          type: "Quotes",
        },
      ],
      true,
    );

    expect(result).toEqual({
      incompleteQuotedRecordRemoved: true,
      rows: [["complete", "row"]],
    });
  });

  it("returns no complete rows when the first quoted record crosses the Range boundary", () => {
    expect(
      completeRowsInDataPreviewChunk(
        [["partial\nquoted field"]],
        [
          {
            code: "MissingQuotes",
            message: "Quoted field unterminated",
            row: 0,
            type: "Quotes",
          },
        ],
        true,
      ),
    ).toEqual({ incompleteQuotedRecordRemoved: true, rows: [] });
  });

  it("does not remove rows for a complete source", () => {
    const rows = [["complete", "row"]];

    expect(completeRowsInDataPreviewChunk(rows, [], false)).toEqual({
      incompleteQuotedRecordRemoved: false,
      rows,
    });
  });

  it.each([
    ["value\n", true],
    ["value\r", true],
    ["value", false],
  ])("recognizes complete record boundary %j", (tail, expected) => {
    expect(endsAtRecordBoundary(tail)).toBe(expected);
  });
});
