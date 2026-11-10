import {
  Maximize01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useMemo, useRef, useState } from "react";

import { createMermaidSandboxDocument } from "./mermaid-preview-adapter";
import "./mermaid-svg-preview.css";

export function MermaidSvgPreview({
  svg,
  title,
  onLoad,
  fitContent = false,
}: {
  svg: string;
  title: string;
  onLoad?: () => void;
  fitContent?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [size, setSize] = useState({ width: 360, height: 240 });
  const [zoom, setZoom] = useState(1);
  const dimensions = useMemo(() => {
    const diagram = new DOMParser()
      .parseFromString(svg, "text/html")
      .querySelector("svg");
    const viewBox = diagram
      ?.getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    const width =
      viewBox?.[2] ?? Number.parseFloat(diagram?.getAttribute("width") ?? "");
    const height =
      viewBox?.[3] ?? Number.parseFloat(diagram?.getAttribute("height") ?? "");
    return Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
      ? { width, height }
      : { width: 640, height: 480 };
  }, [svg]);
  const source = useMemo(() => createMermaidSandboxDocument(svg), [svg]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      // clientWidth/clientHeight round up subpixels and can toggle scrollbars.
      const { width, height } = entry.contentRect;
      if (width < 80 || height < 80) return;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.min(
    size.width / dimensions.width,
    size.height / dimensions.height,
  );
  const width = Math.max(160, dimensions.width * fit * zoom);
  const height = Math.max(120, dimensions.height * fit * zoom);
  const updateZoom = (factor: number) =>
    setZoom((value) => Math.min(4, Math.max(0.25, value * factor)));
  const reset = () => {
    setZoom(1);
    viewport.current?.scrollTo({ left: 0, top: 0 });
  };

  return (
    <div
      className="mermaid-svg-preview"
      contentEditable={false}
      style={
        fitContent
          ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
          : undefined
      }
    >
      <div
        className="mermaid-svg-preview__toolbar"
        role="group"
        aria-label="Mermaid preview zoom"
      >
        <button
          type="button"
          title="Zoom diagram out"
          aria-label="Zoom diagram out"
          disabled={zoom <= 0.25}
          onClick={() => updateZoom(1 / 1.25)}
        >
          <Icon icon={MinusSignIcon} />
        </button>
        <output aria-label="Diagram zoom">{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          title="Zoom diagram in"
          aria-label="Zoom diagram in"
          disabled={zoom >= 4}
          onClick={() => updateZoom(1.25)}
        >
          <Icon icon={PlusSignIcon} />
        </button>
        <button
          type="button"
          title="Fit diagram"
          aria-label="Fit diagram"
          onClick={reset}
        >
          <Icon icon={Maximize01Icon} />
        </button>
      </div>
      <div
        ref={viewport}
        className="mermaid-svg-preview__viewport workspace-scrollbar"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard-focusable scroll region so keyboard users can scroll it
        tabIndex={0}
        role="region"
        aria-label="Diagram canvas"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const element = event.currentTarget;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft =
            drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop =
            drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div
          className="mermaid-svg-preview__plane"
          style={{
            width: Math.max(size.width, width),
            height: Math.max(size.height, height),
          }}
        >
          <iframe
            title={title}
            sandbox=""
            srcDoc={source}
            onLoad={onLoad}
            tabIndex={-1}
            style={{ width, height }}
          />
        </div>
      </div>
    </div>
  );
}
