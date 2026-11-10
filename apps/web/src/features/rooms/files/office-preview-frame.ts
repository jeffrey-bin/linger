import { createViewer, officePlugin } from "@open-file-viewer/core";
import officeViewerStyles from "@open-file-viewer/core/style.css?inline";

import { normalizeOfficePreviewOnce } from "./office-preview-normalization";
import {
  officePreviewProtocol,
  isOfficeScrollPosition,
  type OfficePreviewErrorCode,
  type OfficePreviewFrameMessage,
  type OfficePreviewRenderMessage,
} from "./office-preview-protocol";

const frameStyles = `
  html, body, #office-preview { height: 100%; margin: 0; min-height: 100%; width: 100%; }
  body { background: #f7f8fa; color: #202124; overflow: hidden; }
  .linger-office-preview { border: 0; font-size: 15px; }
  .linger-office-preview .ofv-toolbar { min-height: 44px; }
  .linger-office-preview .ofv-workbook-table { font-size: 14px; }
  .linger-office-preview .ofv-workbook-table td,
  .linger-office-preview .ofv-workbook-table th { line-height: 1.4; padding: 6px 8px; }
`;

const style = document.createElement("style");
style.textContent = `${officeViewerStyles}\n${frameStyles}`;
document.head.append(style);

let removeScrollListener: (() => void) | undefined;
let activeViewer: ReturnType<typeof createViewer> | undefined;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) {
    return;
  }
  if (isProbeMessage(event.data)) {
    announceReady();
    return;
  }
  if (!isRenderMessage(event.data)) {
    return;
  }
  renderOfficeFile(event.data);
});

announceReady();

function renderOfficeFile(message: OfficePreviewRenderMessage) {
  const container = document.querySelector<HTMLElement>("#office-preview");
  if (!container) {
    postError(message.requestId, "render-failed", "Preview host is missing.");
    return;
  }

  removeScrollListener?.();
  activeViewer?.destroy();
  activeViewer = createViewer({
    className: "linger-office-preview",
    container,
    fallback: "custom",
    file: message.buffer,
    fileName: message.filename,
    fit: "contain",
    height: "100%",
    locale: navigator.language.toLowerCase().startsWith("zh")
      ? "zh-CN"
      : "en-US",
    mimeType: message.mediaType,
    onError(error) {
      postError(message.requestId, "render-failed", error.message);
    },
    onLoad() {
      normalizeOfficePreviewOnce(container, message.filename);
      const viewport = container.querySelector<HTMLElement>(".ofv-viewport");
      if (viewport) {
        if (isOfficeScrollPosition(message.scrollPosition)) {
          viewport.scrollTop = message.scrollPosition.top;
          viewport.scrollLeft = message.scrollPosition.left;
        }
        const onScroll = () =>
          postToParent({
            kind: "scroll",
            protocol: officePreviewProtocol,
            requestId: message.requestId,
            position: { top: viewport.scrollTop, left: viewport.scrollLeft },
          });
        viewport.addEventListener("scroll", onScroll, { passive: true });
        removeScrollListener = () =>
          viewport.removeEventListener("scroll", onScroll);
      }
      postToParent({
        kind: "loaded",
        protocol: officePreviewProtocol,
        requestId: message.requestId,
      });
    },
    plugins: [officePlugin()],
    theme: "light",
    toolbar: {
      download: false,
      fullscreen: false,
      print: false,
      rotate: false,
      search: false,
      zoom: true,
    },
    width: "100%",
  });
}

function isRenderMessage(value: unknown): value is OfficePreviewRenderMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "protocol" in value &&
    value.protocol === officePreviewProtocol &&
    "kind" in value &&
    value.kind === "render" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "filename" in value &&
    typeof value.filename === "string" &&
    "mediaType" in value &&
    typeof value.mediaType === "string" &&
    "buffer" in value &&
    value.buffer instanceof ArrayBuffer
  );
}

function isProbeMessage(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "protocol" in value &&
    value.protocol === officePreviewProtocol &&
    "kind" in value &&
    value.kind === "probe"
  );
}

function announceReady() {
  postToParent({ kind: "ready", protocol: officePreviewProtocol });
}

function postError(
  requestId: string,
  code: OfficePreviewErrorCode,
  detail?: string,
) {
  postToParent({
    code,
    detail,
    kind: "error",
    protocol: officePreviewProtocol,
    requestId,
  });
}

function postToParent(message: OfficePreviewFrameMessage) {
  window.parent.postMessage(message, "*");
}
