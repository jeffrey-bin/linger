import { MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState } from "react";

import type { ArtifactRendererKind } from "./artifact-renderer-policy";
import { renderMermaidSvg } from "../mermaid-preview-adapter";
import { MermaidSvgPreview } from "../mermaid-svg-preview";

export interface ArtifactContentRendererProps {
  filename: string;
  kind: Exclude<
    ArtifactRendererKind,
    "csv" | "download" | "markdown" | "media" | "office" | "pdf"
  >;
  objectUrl?: string;
  onError?: (message: string) => void;
  previewUrl?: string;
  textContent?: string;
}

export function ArtifactContentRenderer({
  filename,
  kind,
  objectUrl,
  onError,
  previewUrl,
  textContent,
}: ArtifactContentRendererProps) {
  if (kind === "text") {
    return (
      <pre
        className="min-h-full w-max min-w-full p-6 font-mono text-[15px] leading-6 text-app-body"
        data-content-renderer="text"
      >
        <code>{textContent}</code>
      </pre>
    );
  }

  if (kind === "html") {
    if (previewUrl) {
      return (
        <iframe
          className="block h-full min-h-0 w-full border-0 bg-app-surface"
          sandbox="allow-scripts"
          src={previewUrl}
          title={`Preview ${filename}`}
        />
      );
    }
    return (
      <SandboxedFrame
        filename={filename}
        source={createSandboxDocument(textContent ?? "")}
      />
    );
  }

  if (kind === "mermaid") {
    return (
      <MermaidPreview
        filename={filename}
        onError={onError}
        source={textContent ?? ""}
      />
    );
  }

  if (!objectUrl) {
    return <PreviewUnavailable />;
  }

  if (kind === "image" || kind === "svg") {
    return (
      <ImagePreview
        filename={filename}
        fill={kind === "svg"}
        objectUrl={objectUrl}
      />
    );
  }

  return <PreviewUnavailable />;
}

function ImagePreview({
  fill,
  filename,
  objectUrl,
}: {
  // Vector images scale without loss, so they fill the panel; raster images
  // stop at their natural size.
  fill: boolean;
  filename: string;
  objectUrl: string;
}) {
  const [zoom, setZoom] = useState(1);
  const zoomPercentage = Math.round(zoom * 100);

  function updateZoom(nextZoom: number) {
    setZoom(Math.min(2, Math.max(0.5, Number(nextZoom.toFixed(1)))));
  }

  return (
    <div
      className="relative flex h-full overflow-hidden bg-muted"
      data-testid="image-preview-canvas"
    >
      <div className="workspace-scrollbar h-full w-full overflow-auto">
        <div
          className="flex"
          style={{ height: `${zoom * 100}%`, width: `${zoom * 100}%` }}
        >
          <img
            alt={filename}
            className="m-auto shrink-0 object-contain"
            src={objectUrl}
            style={{
              zoom,
              ...(fill
                ? { height: "100%", width: "100%" }
                : { maxHeight: "100%", maxWidth: "100%" }),
            }}
          />
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex h-8 items-center overflow-hidden rounded-md bg-popover shadow-md">
        <button
          aria-label="Zoom image out"
          className="flex h-8 w-8 items-center justify-center text-app-muted transition-colors hover:bg-accent hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-35"
          disabled={zoom <= 0.5}
          onClick={() => updateZoom(zoom - 0.1)}
          type="button"
        >
          <Icon icon={MinusSignIcon} size={14} />
        </button>
        <button
          aria-label="Reset image zoom"
          className="h-8 min-w-12 border-x border-app-border px-2 text-xs font-medium tabular-nums text-app-body transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setZoom(1)}
          type="button"
        >
          {zoomPercentage}%
        </button>
        <button
          aria-label="Zoom image in"
          className="flex h-8 w-8 items-center justify-center text-app-muted transition-colors hover:bg-accent hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-35"
          disabled={zoom >= 2}
          onClick={() => updateZoom(zoom + 0.1)}
          type="button"
        >
          <Icon icon={PlusSignIcon} size={14} />
        </button>
      </div>
    </div>
  );
}

function MermaidPreview({
  filename,
  onError,
  source,
}: {
  filename: string;
  onError?: (message: string) => void;
  source: string;
}) {
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void (async () => {
      try {
        const result = await renderMermaidSvg(source, {
          signal: controller.signal,
        });
        if (active) setRendered(result);
      } catch (renderError) {
        if (active) {
          const message =
            renderError instanceof Error
              ? renderError.message
              : "Mermaid could not render this diagram.";
          setError(message);
          onError?.(message);
        }
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [onError, source]);

  if (error) {
    return (
      <div className="flex min-h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-semibold">Diagram preview failed</p>
          <p className="mt-1 max-w-lg text-xs text-app-subtle">{error}</p>
        </div>
      </div>
    );
  }

  if (!rendered) {
    return (
      <div
        aria-label="Rendering Mermaid diagram"
        className="flex min-h-full items-center justify-center text-sm text-app-subtle"
        role="status"
      >
        Rendering diagram...
      </div>
    );
  }

  return (
    <MermaidSvgPreview
      key={rendered}
      title={`Preview ${filename}`}
      svg={rendered}
    />
  );
}

function SandboxedFrame({
  filename,
  source,
}: {
  filename: string;
  source: string;
}) {
  return (
    <iframe
      className="h-full min-h-[420px] w-full border-0 bg-app-surface"
      sandbox=""
      srcDoc={source}
      title={`Preview ${filename}`}
    />
  );
}

function createSandboxDocument(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font-family:Inter,system-ui,sans-serif;color:#1f2024}body{padding:24px;box-sizing:border-box}svg{display:block;max-width:100%;height:auto;margin:auto}img{max-width:100%}</style></head><body>${body}</body></html>`;
}

function PreviewUnavailable() {
  return (
    <p className="text-sm text-app-subtle">Preview content is unavailable.</p>
  );
}
