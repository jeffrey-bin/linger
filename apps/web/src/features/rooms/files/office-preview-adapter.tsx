import { Spinner } from "@/components/ui/spinner";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ArtifactReadingPosition } from "./artifact-preview-cache";
import { officePreviewLimits } from "./office-preview-limits";
import {
  getOfficePreviewFrameUrl,
  loadOfficePreviewFrameSource,
} from "./office-preview-frame-source";
import {
  retainOfficePreviewPreflightWorker,
  takeOfficePreviewPreflightWorker,
} from "./office-preview-preflight-cache";
import {
  isOfficePreviewFrameMessage,
  officePreviewProtocol,
  type OfficePreviewErrorCode,
  type OfficePreviewPreflightRequest,
  type OfficePreviewPreflightResponse,
  type OfficePreviewProbeMessage,
  type OfficePreviewRenderMessage,
} from "./office-preview-protocol";
import { PreviewAdapterError } from "./preview-adapter-error";
import { triggerArtifactDownload } from "./artifact-preview-loader";

export interface OfficePreviewAdapterProps {
  blob: Blob;
  readingPosition?: ArtifactReadingPosition;
  filename: string;
  mediaType: string;
  onError?: (message: string) => void;
}

export function OfficePreviewAdapter({
  blob,
  filename,
  mediaType,
  onError,
  readingPosition,
}: OfficePreviewAdapterProps) {
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<"loading" | "loaded">("loading");
  const requestId = useMemo(createRequestId, [blob, filename, mediaType]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    let active = true;
    let preflightWorker: Worker | undefined;
    const stopPreflightWorker = (completed = false) => {
      preflightWorker?.removeEventListener("message", handlePreflightMessage);
      preflightWorker?.removeEventListener("error", handlePreflightError);
      if (preflightWorker) {
        if (completed) retainOfficePreviewPreflightWorker(preflightWorker);
        else preflightWorker.terminate();
      }
      preflightWorker = undefined;
    };
    let preflightTimer: number | undefined;
    let renderTimer: number | undefined;
    let frameReady = false;
    let preparedBuffer: ArrayBuffer | undefined;
    let rendered = false;
    let preflightComplete = false;
    setError(undefined);
    setStatus("loading");
    // Separated from the render timeout on purpose: a sandbox that never
    // answers (its module chunk blocked or still in flight) and a renderer
    // that stalled on the bytes need different follow-up, and a shared
    // message made the two indistinguishable in bug reports.
    const bootTimer = window.setTimeout(
      () =>
        fail(
          "timeout",
          "The basic Office preview sandbox did not start. Reload the page to retry.",
        ),
      officePreviewLimits.renderTimeoutMs,
    );

    const fail = (code: OfficePreviewErrorCode, detail?: string) => {
      if (!active) {
        return;
      }
      active = false;
      stopPreflightWorker();
      terminateOfficePreviewFrame(frame);
      window.clearTimeout(preflightTimer);
      window.clearTimeout(renderTimer);
      window.clearTimeout(bootTimer);
      const message = officePreviewErrorMessage(code, detail);
      setError(message);
      onErrorRef.current?.(message);
    };

    const renderWhenReady = () => {
      if (!active || !frameReady || !preparedBuffer || rendered) return;
      rendered = true;
      const message: OfficePreviewRenderMessage = {
        buffer: preparedBuffer,
        filename,
        kind: "render",
        mediaType,
        protocol: officePreviewProtocol,
        requestId,
        scrollPosition: readingPosition?.officeScroll,
      };
      preparedBuffer = undefined;
      frame.contentWindow?.postMessage(message, "*", [message.buffer]);
      renderTimer = window.setTimeout(
        () => fail("timeout"),
        officePreviewLimits.renderTimeoutMs,
      );
    };

    function handlePreflightMessage(
      event: MessageEvent<OfficePreviewPreflightResponse>,
    ) {
      if (!active || preflightComplete || event.data.requestId !== requestId) {
        return;
      }
      preflightComplete = true;
      stopPreflightWorker(true);
      window.clearTimeout(preflightTimer);
      if (event.data.kind === "failed") {
        fail(event.data.code, event.data.detail);
        return;
      }

      preparedBuffer = event.data.buffer;
      renderWhenReady();
    }
    const handlePreflightError = () => fail("invalid-file");

    const startPreflight = async () => {
      try {
        const buffer = await blob.arrayBuffer();
        if (!active) {
          return;
        }
        preflightTimer = window.setTimeout(
          () => fail("timeout"),
          officePreviewLimits.preflightTimeoutMs,
        );
        preflightWorker = takeOfficePreviewPreflightWorker();
        preflightWorker.addEventListener("message", handlePreflightMessage);
        preflightWorker.addEventListener("error", handlePreflightError);
        const request: OfficePreviewPreflightRequest = {
          buffer,
          filename,
          mediaType,
          requestId,
        };
        preflightWorker.postMessage(request, [buffer]);
      } catch (error) {
        fail(
          "invalid-file",
          error instanceof Error ? error.message : undefined,
        );
      }
    };

    const handleFrameMessage = (event: MessageEvent<unknown>) => {
      if (
        !active ||
        event.source !== frame.contentWindow ||
        !isOfficePreviewFrameMessage(event.data)
      ) {
        return;
      }
      if (event.data.kind === "ready") {
        window.clearTimeout(bootTimer);
        frameReady = true;
        renderWhenReady();
        return;
      }
      if (event.data.requestId !== requestId) {
        return;
      }
      if (event.data.kind === "error") {
        fail(event.data.code, event.data.detail);
        return;
      }

      if (event.data.kind === "scroll") {
        if (readingPosition) readingPosition.officeScroll = event.data.position;
        return;
      }
      if (!rendered) return;
      window.clearTimeout(renderTimer);
      setStatus("loaded");
    };

    const probeFrame = () => {
      const message: OfficePreviewProbeMessage = {
        kind: "probe",
        protocol: officePreviewProtocol,
      };
      frame.contentWindow?.postMessage(message, "*");
    };

    window.addEventListener("message", handleFrameMessage);
    frame.addEventListener("load", probeFrame);
    void loadOfficePreviewFrameSource(filename)
      .then((source) => {
        if (!active) return;
        frame.removeAttribute("src");
        frame.srcdoc = createFrameDocument(
          getOfficePreviewFrameUrl(filename),
          source,
        );
      })
      .catch(() => fail("render-failed"));
    void startPreflight();
    return () => {
      active = false;
      preparedBuffer = undefined;
      stopPreflightWorker();
      terminateOfficePreviewFrame(frame);
      window.clearTimeout(preflightTimer);
      window.clearTimeout(renderTimer);
      window.clearTimeout(bootTimer);
      frame.removeEventListener("load", probeFrame);
      window.removeEventListener("message", handleFrameMessage);
    };
  }, [blob, filename, mediaType, readingPosition, requestId]);

  if (error) {
    return (
      <PreviewAdapterError
        message={error}
        onDownload={() => triggerArtifactDownload(blob, filename)}
      />
    );
  }

  return (
    <div className="relative h-full min-h-[420px] w-full bg-app-surface-soft">
      {/* The effect below owns this frame's navigation. Declaring srcDoc here
          as well wrote the same attribute twice per mount, and assigning
          srcdoc queues a navigation, so the second writer could reload the
          document the handshake had already accepted. One owner keeps the
          document that answers "ready" the one that receives the render. */}
      <iframe
        className="h-full min-h-[420px] w-full border-0 bg-app-surface-soft"
        ref={frameRef}
        key={requestId}
        sandbox="allow-scripts"
        title={`Basic preview ${filename}`}
      />
      {status === "loading" ? (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 bg-app-surface-soft text-sm text-app-subtle"
          role="status"
        >
          <Spinner size={16} />
          Preparing basic preview
        </div>
      ) : null}
    </div>
  );
}

function createFrameDocument(officePreviewFrameUrl: string, source?: string) {
  const frameSource = new URL(officePreviewFrameUrl, window.location.href).href;
  const allowedScriptOrigin = new URL(frameSource).origin;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const scriptPolicy =
    source === undefined ? escapeHtml(allowedScriptOrigin) : `'nonce-${nonce}'`;
  const script =
    source === undefined
      ? `<script type="module" src="${escapeHtml(frameSource)}"></script>`
      : `<script type="module" nonce="${nonce}">${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptPolicy}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="office-preview"></div>${script}</body></html>`;
}

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `office-preview-${Date.now()}`;
}

function terminateOfficePreviewFrame(frame: HTMLIFrameElement) {
  frame.removeAttribute("srcdoc");
  frame.setAttribute("src", "about:blank");
}

function officePreviewErrorMessage(
  code: OfficePreviewErrorCode,
  detail?: string,
) {
  const messages: Record<OfficePreviewErrorCode, string> = {
    "encrypted-file":
      "This Office file is encrypted and cannot be shown in basic preview.",
    "invalid-container":
      "This Office file is damaged or has an invalid document structure.",
    "invalid-file": "This Office file could not be read for basic preview.",
    "limit-exceeded":
      detail ?? "This Office file exceeds the safe basic preview limits.",
    "render-failed": "Basic Office preview failed for this file.",
    timeout: detail ?? "Basic Office preview took too long and was stopped.",
    "unsupported-file":
      "This Office format is not supported for basic preview.",
  };
  return messages[code];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
