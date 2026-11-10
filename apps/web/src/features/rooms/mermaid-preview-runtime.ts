import {
  mermaidPreviewMaxSourceLength,
  mermaidPreviewRenderId,
  type MermaidPreviewRequest,
  type MermaidPreviewResponse,
} from "./mermaid-preview-protocol";

const mermaid = await loadMermaid();

if (mermaid) {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || !isRenderRequest(event.data)) return;
    void render(mermaid, event.data, event.origin);
  });
  post({ kind: "linger.mermaid.ready" }, "*");
}

async function render(
  runtime: Awaited<ReturnType<typeof loadMermaid>> & {},
  request: MermaidPreviewRequest,
  targetOrigin: string,
) {
  try {
    if (request.source.length > mermaidPreviewMaxSourceLength) {
      throw new Error("Mermaid source is too large to preview safely.");
    }
    await runtime.parse(request.source);
    const result = await runtime.render(
      mermaidPreviewRenderId(request.requestId),
      request.source,
    );
    post(
      {
        kind: "linger.mermaid.result",
        requestId: request.requestId,
        svg: result.svg,
      },
      targetOrigin,
    );
  } catch (error) {
    post(
      {
        error:
          error instanceof Error
            ? error.message
            : "Mermaid could not render this diagram.",
        kind: "linger.mermaid.error",
        requestId: request.requestId,
      },
      targetOrigin,
    );
  }
}

function post(message: MermaidPreviewResponse, targetOrigin: string) {
  window.parent.postMessage(message, targetOrigin);
}

function isRenderRequest(value: unknown): value is MermaidPreviewRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MermaidPreviewRequest>;
  return (
    candidate.kind === "linger.mermaid.render" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.source === "string"
  );
}

async function loadMermaid() {
  try {
    const { default: runtime } = await import("mermaid");
    runtime.initialize({
      htmlLabels: false,
      maxTextSize: mermaidPreviewMaxSourceLength,
      securityLevel: "strict",
      startOnLoad: false,
      theme: "neutral",
    });
    return runtime;
  } catch {
    return undefined;
  }
}
