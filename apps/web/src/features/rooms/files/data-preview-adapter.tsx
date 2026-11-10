import { useVirtualizer } from "@tanstack/react-virtual";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import dataPreviewWorkerUrl from "./data-preview-worker.ts?worker&url";
import {
  dataPreviewLimits,
  type DataPreviewRequest,
  type DataPreviewResponse,
} from "./data-preview-protocol";

export interface DataPreviewAdapterProps {
  blob: Blob;
  filename: string;
  mediaType: string;
  onError?: (message: string) => void;
  sourceSizeBytes?: number;
}

export function DataPreviewAdapter({
  blob,
  filename,
  mediaType,
  onError,
  sourceSizeBytes = blob.size,
}: DataPreviewAdapterProps) {
  const [result, setResult] =
    useState<Extract<DataPreviewResponse, { kind: "parsed" }>>();
  const [error, setError] = useState<string>();
  const reportError = useEffectEvent((message: string) => onError?.(message));

  useEffect(() => {
    const worker = new Worker(dataPreviewWorkerUrl, { type: "module" });
    const requestId = globalThis.crypto?.randomUUID?.() ?? `data-${Date.now()}`;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
    };
    const handleMessage = (event: MessageEvent<DataPreviewResponse>) => {
      if (event.data.requestId !== requestId) return;
      dispose();
      if (event.data.kind === "failed") {
        setError(event.data.message);
        reportError(event.data.message);
      } else {
        setResult(event.data);
      }
    };
    const handleError = () => {
      dispose();
      const message = "Data preview could not be parsed.";
      setError(message);
      reportError(message);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    const timer = window.setTimeout(() => {
      dispose();
      const message = "Data preview took too long and was stopped.";
      setError(message);
      reportError(message);
    }, dataPreviewLimits.timeoutMs);
    const request: DataPreviewRequest = {
      blob,
      delimiter:
        filename.toLowerCase().endsWith(".tsv") ||
        mediaType === "text/tab-separated-values"
          ? "\t"
          : ",",
      requestId,
      sourceSizeBytes,
    };
    worker.postMessage(request);
    return dispose;
  }, [blob, filename, mediaType, sourceSizeBytes]);

  if (error) {
    return (
      <p className="p-8 text-center text-sm text-app-danger" role="alert">
        {error}
      </p>
    );
  }
  if (!result) {
    return (
      <div
        className="flex h-full min-h-[420px] items-center justify-center gap-2 text-sm text-app-subtle"
        role="status"
      >
        <Spinner size={16} />
        Parsing data preview...
      </div>
    );
  }

  return <VirtualDataGrid filename={filename} result={result} />;
}

function VirtualDataGrid({
  filename,
  result,
}: {
  filename: string;
  result: Extract<DataPreviewResponse, { kind: "parsed" }>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnCount = useMemo(
    () =>
      result.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    [result.rows],
  );
  const rows = useVirtualizer({
    count: result.rows.length,
    estimateSize: () => 34,
    getScrollElement: () => scrollRef.current,
    overscan: 10,
  });
  const columns = useVirtualizer({
    count: columnCount,
    estimateSize: () => 180,
    getScrollElement: () => scrollRef.current,
    horizontal: true,
    overscan: 3,
  });
  const visibleColumns = columns.getVirtualItems();

  return (
    <section
      aria-label={`Data preview ${filename}`}
      className="flex h-full min-h-[420px] flex-col bg-app-surface"
      role="table"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-3 border-b border-app-border px-3 text-xs text-app-muted">
        <span>{result.rows.length.toLocaleString()} rows</span>
        <span>{columnCount.toLocaleString()} columns</span>
        {result.truncated ? (
          <span className="text-app-warning">
            {result.truncationReason ?? "Preview is truncated."}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
        <div
          className="relative text-[14px] text-app-body"
          style={{
            height: `${rows.getTotalSize() + 35}px`,
            minWidth: `${columns.getTotalSize() + 52}px`,
          }}
        >
          <div
            className="sticky top-0 z-20 h-[35px] border-b border-app-border bg-app-sidebar font-medium"
            role="row"
          >
            <div className="sticky left-0 z-30 flex h-[35px] w-[52px] items-center justify-center border-r border-app-border bg-app-sidebar text-app-subtle">
              #
            </div>
            {visibleColumns.map((column) => (
              <div
                className="absolute top-0 flex h-[35px] items-center border-r border-app-border bg-app-sidebar px-2"
                key={column.key}
                role="columnheader"
                style={{ left: column.start + 52, width: column.size }}
              >
                {columnLabel(column.index)}
              </div>
            ))}
          </div>
          {rows.getVirtualItems().map((virtualRow) => {
            const row = result.rows[virtualRow.index] ?? [];
            return (
              <div
                className="absolute left-0 border-b border-app-border/70"
                key={virtualRow.key}
                role="row"
                style={{
                  height: virtualRow.size,
                  top: virtualRow.start + 35,
                  width: columns.getTotalSize() + 52,
                }}
              >
                <div className="sticky left-0 z-10 flex h-full w-[52px] items-center justify-center border-r border-app-border bg-app-sidebar text-[12px] text-app-subtle">
                  {virtualRow.index + 1}
                </div>
                {visibleColumns.map((column) => (
                  <div
                    className="absolute top-0 flex h-full items-center overflow-hidden border-r border-app-border/70 px-2"
                    key={column.key}
                    role="gridcell"
                    style={{ left: column.start + 52, width: column.size }}
                    title={row[column.index] ?? ""}
                  >
                    <span className="truncate">{row[column.index] ?? ""}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function columnLabel(index: number) {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}
