import { afterEach, expect, it, vi } from "vitest";
import {
  dataPreviewLimits,
  type DataPreviewRequest,
  type DataPreviewResponse,
} from "./data-preview-protocol";

class BlobReader {
  onload?: (event: { target: { result: string } }) => void;
  onerror?: (error: unknown) => void;
  readAsText(blob: Blob) {
    void blob.text().then(
      (result) => this.onload?.({ target: { result } }),
      (error: unknown) => this.onerror?.(error),
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function preview(source: string, sourceSizeBytes?: number) {
  let receive: ((event: { data: DataPreviewRequest }) => void) | undefined;
  let deliver!: (response: DataPreviewResponse) => void;
  const response = new Promise<DataPreviewResponse>((resolve) => {
    deliver = resolve;
  });
  vi.stubGlobal("FileReader", BlobReader);
  vi.stubGlobal("self", {
    addEventListener: (_name: string, handler: typeof receive) => {
      receive = handler;
    },
    postMessage: (value: DataPreviewResponse) => deliver(value),
  });
  await import("./data-preview-worker");
  const blob = new Blob([source]);
  receive?.({
    data: {
      blob,
      delimiter: ",",
      requestId: "regression",
      sourceSizeBytes: sourceSizeBytes ?? blob.size,
    },
  });
  return response;
}

it("reports malformed complete CSV as failed instead of a successful partial preview", async () => {
  const response = await preview('name,value\n"unterminated');
  expect(response.kind).toBe("failed");
});

it("reports an oversized cell as failed instead of a successful partial preview", async () => {
  const response = await preview(
    "x".repeat(dataPreviewLimits.maxCellCharacters + 1),
  );
  expect(response.kind).toBe("failed");
});

it("keeps all complete rows when the row limit stops before the byte boundary", async () => {
  const source = Array.from(
    { length: dataPreviewLimits.maxRows + 5 },
    (_, n) => `row-${n},value`,
  ).join("\n");
  const response = await preview(source, new Blob([source]).size + 100);
  expect(response.kind).toBe("parsed");
  if (response.kind !== "parsed") throw new Error(response.message);
  expect(response.rows).toHaveLength(dataPreviewLimits.maxRows);
  expect(response.rows.at(-1)).toEqual([
    `row-${dataPreviewLimits.maxRows - 1}`,
    "value",
  ]);
});
