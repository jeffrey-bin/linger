export const mermaidPreviewRuntimePath = "/mermaid-preview-runtime.html";
export const mermaidPreviewLoadTimeoutMs = 15_000;
export const mermaidPreviewRenderTimeoutMs = 5_000;
export const mermaidPreviewMaxSourceLength = 200_000;
export const mermaidPreviewMaxSvgLength = 4_000_000;

export function mermaidPreviewRenderId(requestId: string) {
  return `mermaid-${requestId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

export interface MermaidPreviewRequest {
  kind: "linger.mermaid.render";
  requestId: string;
  source: string;
}

export type MermaidPreviewResponse =
  | { kind: "linger.mermaid.ready" }
  | {
      kind: "linger.mermaid.result";
      requestId: string;
      svg: string;
    }
  | {
      error: string;
      kind: "linger.mermaid.error";
      requestId: string;
    };
