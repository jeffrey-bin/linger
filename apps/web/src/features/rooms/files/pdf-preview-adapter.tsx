import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { Button } from "@/components/ui/button";
import type { ArtifactReadingPosition } from "./artifact-preview-cache";
import { repairEscapedNewlinePdf } from "./pdf-preview-bytes";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const maxPdfPages = 500;

export interface PdfPreviewAdapterProps {
  blob: Blob;
  readingPosition?: ArtifactReadingPosition;
  filename: string;
  onError?: (message: string) => void;
}

export function PdfPreviewAdapter({
  blob,
  filename,
  onError,
  readingPosition,
}: PdfPreviewAdapterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onErrorRef = useRef(onError);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  const [pageNumber, setPageNumber] = useState(
    readingPosition?.pageNumber ?? 1,
  );
  const [rendering, setRendering] = useState(true);
  const [scale, setScale] = useState(readingPosition?.scale ?? 1);
  const [availableWidth, setAvailableWidth] = useState(720);

  useLayoutEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextWidth = Math.round(Math.max(280, entry.contentRect.width - 48));
      setAvailableWidth((current) =>
        current === nextWidth ? current : nextWidth,
      );
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(undefined);
    setError(undefined);
    setRendering(true);
    void blob
      .arrayBuffer()
      .then((data) => {
        if (!active) return undefined;
        task = getDocument({
          data: new Uint8Array(repairEscapedNewlinePdf(data)),
          stopAtErrors: true,
          useWorkerFetch: false,
        });
        return task.promise;
      })
      .then((nextDocument) => {
        if (!nextDocument) return;
        if (!active) {
          void task?.destroy();
          return;
        }
        if (nextDocument.numPages > maxPdfPages) {
          void task?.destroy();
          throw new Error(
            `This PDF has more than ${maxPdfPages} pages and exceeds the basic preview limit.`,
          );
        }
        setDocument(nextDocument);
        setPageNumber(
          Math.min(
            nextDocument.numPages,
            Math.max(1, readingPosition?.pageNumber ?? 1),
          ),
        );
        setScale(readingPosition?.scale ?? 1);
        setError(undefined);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        const message =
          loadError instanceof Error
            ? `PDF preview failed: ${loadError.message}`
            : "PDF preview failed for this file.";
        setError(message);
        onErrorRef.current?.(message);
      });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [blob, readingPosition]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !document) return;
    let active = true;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;
    setRendering(true);
    void document
      .getPage(pageNumber)
      .then((page) => {
        if (!active) return;
        const natural = page.getViewport({ scale: 1 });
        const fittedScale = Math.min(2.25, availableWidth / natural.width);
        const viewport = page.getViewport({ scale: fittedScale * scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas rendering is unavailable.");
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          transform:
            pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
          viewport,
        });
        return renderTask.promise;
      })
      .then(() => {
        if (active) {
          if (readingPosition) {
            if (viewportRef.current) {
              viewportRef.current.scrollTop = readingPosition.scrollTop ?? 0;
              viewportRef.current.scrollLeft = readingPosition.scrollLeft ?? 0;
            }
          }
          setRendering(false);
        }
      })
      .catch((renderError: unknown) => {
        if (
          !active ||
          (renderError instanceof Error &&
            renderError.name === "RenderingCancelledException")
        ) {
          return;
        }
        const message =
          renderError instanceof Error
            ? `PDF page rendering failed: ${renderError.message}`
            : "PDF page rendering failed.";
        setError(message);
        onErrorRef.current?.(message);
      });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [availableWidth, document, pageNumber, readingPosition, scale]);

  function changePage(next: number) {
    if (readingPosition) {
      readingPosition.pageNumber = next;
      readingPosition.scrollTop = 0;
      readingPosition.scrollLeft = 0;
    }
    setPageNumber(next);
  }

  function changeScale(next: number) {
    if (readingPosition) readingPosition.scale = next;
    setScale(next);
  }

  return (
    <section
      aria-label={`PDF preview ${filename}`}
      className="flex h-full min-h-[420px] flex-col bg-app-surface-soft"
      role="document"
    >
      <div className="flex h-11 shrink-0 items-center justify-center gap-1 border-b border-app-border bg-app-surface px-2">
        <Button
          aria-label="Previous PDF page"
          disabled={!document || pageNumber <= 1}
          onClick={() => changePage(Math.max(1, pageNumber - 1))}
          size="icon"
          tone="ghost"
        >
          <Icon icon={ArrowLeft01Icon} />
        </Button>
        <span className="min-w-24 text-center text-xs text-app-muted">
          {document ? `${pageNumber} / ${document.numPages}` : "Loading"}
        </span>
        <Button
          aria-label="Next PDF page"
          disabled={!document || pageNumber >= document.numPages}
          onClick={() =>
            changePage(
              Math.min(document?.numPages ?? pageNumber, pageNumber + 1),
            )
          }
          size="icon"
          tone="ghost"
        >
          <Icon icon={ArrowRight01Icon} />
        </Button>
        <span className="mx-1 h-5 w-px bg-app-border" />
        <Button
          aria-label="Zoom PDF out"
          disabled={scale <= 0.6}
          onClick={() => changeScale(Math.max(0.6, scale - 0.2))}
          size="icon"
          tone="ghost"
        >
          <Icon icon={ZoomOutAreaIcon} />
        </Button>
        <Button
          aria-label="Zoom PDF in"
          disabled={scale >= 2}
          onClick={() => changeScale(Math.min(2, scale + 0.2))}
          size="icon"
          tone="ghost"
        >
          <Icon icon={ZoomInAreaIcon} />
        </Button>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-auto p-6"
        onScroll={(event) => {
          if (!readingPosition || rendering) return;
          readingPosition.scrollTop = event.currentTarget.scrollTop;
          readingPosition.scrollLeft = event.currentTarget.scrollLeft;
        }}
        ref={viewportRef}
      >
        {error ? (
          <p
            className="m-auto max-w-md py-10 text-center text-sm text-app-danger"
            role="alert"
          >
            {error}
          </p>
        ) : (
          <canvas
            aria-label={`PDF page ${pageNumber}`}
            className="mx-auto block bg-white shadow-sm"
            ref={canvasRef}
          />
        )}
        {rendering && !error ? (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2 bg-app-surface-soft/80 text-sm text-app-subtle"
            role="status"
          >
            <Spinner size={16} />
            Rendering PDF...
          </div>
        ) : null}
      </div>
    </section>
  );
}
