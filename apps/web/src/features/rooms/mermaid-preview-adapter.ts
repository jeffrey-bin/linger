import DOMPurify from "dompurify";

import {
  mermaidPreviewLoadTimeoutMs,
  mermaidPreviewMaxSourceLength,
  mermaidPreviewMaxSvgLength,
  mermaidPreviewRenderTimeoutMs,
  mermaidPreviewRuntimePath,
  type MermaidPreviewRequest,
  type MermaidPreviewResponse,
} from "./mermaid-preview-protocol";

const svgNamespace = "http://www.w3.org/2000/svg";

export async function renderMermaidSvg(
  source: string,
  options: {
    loadTimeoutMs?: number;
    renderTimeoutMs?: number;
    runtimePath?: string;
    signal?: AbortSignal;
  } = {},
) {
  if (source.length > mermaidPreviewMaxSourceLength) {
    throw new Error("Mermaid source is too large to preview safely.");
  }
  if (options.signal?.aborted) throw abortError();

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = options.runtimePath ?? mermaidPreviewRuntimePath;
  Object.assign(frame.style, {
    border: "0",
    clip: "rect(0 0 0 0)",
    clipPath: "inset(50%)",
    height: "1px",
    overflow: "hidden",
    pointerEvents: "none",
    position: "fixed",
    whiteSpace: "nowrap",
    width: "1px",
  });
  frame.title = "Mermaid rendering runtime";

  const requestId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const request: MermaidPreviewRequest = {
    kind: "linger.mermaid.render",
    requestId,
    source,
  };

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeout = window.setTimeout(
      () => finish(new Error("Mermaid preview runtime did not load in time.")),
      options.loadTimeoutMs ?? mermaidPreviewLoadTimeoutMs,
    );

    const finish = (error?: Error, svg?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      options.signal?.removeEventListener("abort", onAbort);
      frame.remove();
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(sanitizeMermaidSvg(svg ?? ""));
      } catch (sanitizeError) {
        reject(
          sanitizeError instanceof Error
            ? sanitizeError
            : new Error("Mermaid preview output could not be sanitized."),
        );
      }
    };
    const onAbort = () => finish(abortError());
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.contentWindow ||
        !isRuntimeResponse(event.data)
      ) {
        return;
      }
      if (event.data.kind === "linger.mermaid.ready") {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(
          () =>
            finish(
              new Error("Mermaid preview exceeded the execution time limit."),
            ),
          options.renderTimeoutMs ?? mermaidPreviewRenderTimeoutMs,
        );
        frame.contentWindow?.postMessage(request, "*");
        return;
      }
      if (event.data.requestId !== requestId) return;
      if (event.data.kind === "linger.mermaid.error") {
        finish(new Error(event.data.error));
        return;
      }
      if (event.data.svg.length > mermaidPreviewMaxSvgLength) {
        finish(
          new Error("Mermaid preview output is too large to display safely."),
        );
        return;
      }
      finish(undefined, event.data.svg);
    };

    window.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    document.body.appendChild(frame);
  });
}

export function sanitizeMermaidSvg(svg: string) {
  return DOMPurify.sanitize(normalizeMermaidLabels(svg), {
    FORBID_TAGS: ["foreignObject", "script"],
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

export function createMermaidSandboxDocument(svg: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}body>svg{display:block;width:100%;height:100%;max-width:none!important}</style></head><body>${svg}</body></html>`;
}

function normalizeMermaidLabels(svg: string) {
  // Mermaid serializes HTML inside foreignObject, including void <br> tags.
  const document = new DOMParser().parseFromString(svg, "text/html");
  const diagram = document.querySelector("svg");
  if (!diagram) return "";

  for (const foreignObject of diagram.querySelectorAll("foreignObject")) {
    const lines = mermaidLabelLines(foreignObject);
    if (lines.length === 0) {
      foreignObject.remove();
      continue;
    }

    const centerX =
      numericSvgAttribute(foreignObject, "x") +
      numericSvgAttribute(foreignObject, "width") / 2;
    const centerY =
      numericSvgAttribute(foreignObject, "y") +
      numericSvgAttribute(foreignObject, "height") / 2;
    const text = document.createElementNS(svgNamespace, "text");
    text.setAttribute("x", String(centerX));
    text.setAttribute("y", String(centerY));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    const firstLineOffset = -((lines.length - 1) * 0.55);
    lines.forEach((line, index) => {
      const tspan = document.createElementNS(svgNamespace, "tspan");
      tspan.setAttribute("x", String(centerX));
      tspan.setAttribute("dy", index === 0 ? `${firstLineOffset}em` : "1.1em");
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    foreignObject.replaceWith(text);
  }

  return new XMLSerializer().serializeToString(diagram);
}

function numericSvgAttribute(element: Element, name: string) {
  const value = Number.parseFloat(element.getAttribute(name) ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function mermaidLabelLines(label: Element) {
  for (const br of label.querySelectorAll("br")) {
    br.replaceWith(label.ownerDocument.createTextNode("\n"));
  }
  const paragraphs = Array.from(label.querySelectorAll("p")).flatMap(
    (paragraph) => {
      const text = paragraph.textContent?.trim();
      return text ? text.split("\n") : [];
    },
  );
  if (paragraphs.length > 0) return paragraphs;
  const text = label.textContent?.trim();
  return text ? text.split("\n") : [];
}

function isRuntimeResponse(value: unknown): value is MermaidPreviewResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MermaidPreviewResponse>;
  if (candidate.kind === "linger.mermaid.ready") return true;
  if (
    candidate.kind === "linger.mermaid.result" &&
    "requestId" in candidate &&
    "svg" in candidate
  ) {
    return (
      typeof candidate.requestId === "string" &&
      typeof candidate.svg === "string"
    );
  }
  return (
    candidate.kind === "linger.mermaid.error" &&
    "requestId" in candidate &&
    "error" in candidate &&
    typeof candidate.requestId === "string" &&
    typeof candidate.error === "string"
  );
}

function abortError() {
  return new DOMException("Mermaid preview was cancelled.", "AbortError");
}
