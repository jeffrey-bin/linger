/// <reference lib="webworker" />

import {
  inspectOfficePreviewFileContents,
  inspectSpreadsheetRanges,
  OfficePreviewGuardError,
} from "./office-preview-guard";
import type {
  OfficePreviewPreflightRequest,
  OfficePreviewPreflightResponse,
} from "./office-preview-protocol";

self.addEventListener(
  "message",
  (event: MessageEvent<OfficePreviewPreflightRequest>) => {
    void preflight(event.data);
  },
);

async function preflight(request: OfficePreviewPreflightRequest) {
  try {
    const metadata = await inspectOfficePreviewFileContents(request);
    if (metadata.isSpreadsheet) {
      const xlsx = await import("xlsx");
      const workbook = xlsx.read(request.buffer, {
        cellFormula: false,
        cellHTML: false,
        cellNF: false,
        cellStyles: false,
        cellText: false,
        cellDates: false,
        dense: true,
        sheetRows: 20_001,
        type: "array",
      });
      inspectSpreadsheetRanges(
        workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          return { name, range: sheet?.["!fullref"] ?? sheet?.["!ref"] };
        }),
      );
    }

    const response: OfficePreviewPreflightResponse = {
      buffer: request.buffer,
      kind: "passed",
      requestId: request.requestId,
    };
    self.postMessage(response, { transfer: [request.buffer] });
  } catch (error) {
    const response: OfficePreviewPreflightResponse = {
      code:
        error instanceof OfficePreviewGuardError ? error.code : "invalid-file",
      detail: error instanceof Error ? error.message : undefined,
      kind: "failed",
      requestId: request.requestId,
    };
    self.postMessage(response);
  }
}
