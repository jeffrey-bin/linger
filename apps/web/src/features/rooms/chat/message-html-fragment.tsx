import {
  Copy01Icon,
  Download04Icon,
  MoreHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";

import { writeClipboardText } from "@/lib/clipboard";

import {
  appFontFaces,
  currentFragmentTheme,
  fragmentDownloadFileName,
  hostedFragmentDocument,
  htmlFragmentSizeMessageType,
} from "./html-fragment-host";

const minFragmentHeight = 48;

function downloadFragmentFile(title: string, html: string) {
  const isSvg = /^\s*<svg[\s>]/i.test(html);
  const blob = new Blob([html], {
    type: isSvg ? "image/svg+xml;charset=utf-8" : "text/html;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fragmentDownloadFileName(title, html);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function MessageHtmlFragment({
  html,
  title,
}: {
  html: string;
  title: string;
}) {
  // The fragment takes the app's theme values, so its colors and font match.
  const source = useMemo(
    () => hostedFragmentDocument(html, currentFragmentTheme(), appFontFaces()),
    [html],
  );
  return <HtmlFragmentFrame source={source} title={title} widgetHtml={html} />;
}

export function HtmlFragmentFrame({
  source,
  title,
  widgetHtml,
}: {
  source: string;
  title: string;
  widgetHtml: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minFragmentHeight);
  // The width cap the fragment declares, if any; otherwise the chat width.
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (
        !event.data ||
        event.data.type !== htmlFragmentSizeMessageType ||
        typeof event.data.height !== "number"
      ) {
        return;
      }
      setHeight(Math.max(minFragmentHeight, Math.ceil(event.data.height)));
      const width = event.data.width;
      setContentWidth(
        typeof width === "number" && width > 0 ? Math.ceil(width) : null,
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      // An explicit width, the chat card width like every other card: the
      // Message column shrinks to fit, so a percentage alone would leave the
      // frame at an iframe's default 300px. A fragment that caps its own
      // width narrower gets a frame that hugs it (plus the 1px border on
      // each side).
      className="group relative my-2 max-w-full"
      style={{
        width: contentWidth
          ? `min(${contentWidth + 2}px, var(--chat-card-width))`
          : "var(--chat-card-width)",
      }}
    >
      <iframe
        className="block w-full rounded-xl border border-app-border bg-app-surface shadow-[var(--chat-card-shadow)]"
        data-html-fragment=""
        ref={frameRef}
        sandbox="allow-scripts"
        srcDoc={source}
        // The reported height is the content's; the 1px border on each side
        // comes on top, so the fragment shows in full without a scrollbar.
        style={{ height: height + 2 }}
        title={title}
      />
      <FragmentHostActions html={widgetHtml} title={title} />
    </div>
  );
}

function FragmentHostActions({ html, title }: { html: string; title: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`absolute right-2 top-2 z-10 ${
        open
          ? "opacity-100"
          : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
      }`}
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Widget actions"
        className="flex size-7 items-center justify-center rounded-md border border-transparent bg-app-surface text-app-muted shadow-sm transition-colors hover:bg-app-hover hover:text-app-ink"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Icon icon={MoreHorizontalIcon} size={16} />
      </button>
      {open ? (
        <div
          className="absolute right-0 mt-1 w-max min-w-[12rem] rounded-xl border border-app-border bg-app-surface p-1.5 shadow-md"
          role="menu"
        >
          <button
            className="flex w-full shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2 py-2 text-left text-sm text-app-ink hover:bg-app-hover"
            onClick={() => {
              void writeClipboardText(html)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                })
                .catch(() => setCopied(false));
            }}
            role="menuitem"
            type="button"
          >
            {copied ? (
              <Icon icon={Tick02Icon} size={16} />
            ) : (
              <Icon icon={Copy01Icon} size={16} />
            )}
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
          <button
            className="flex w-full shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2 py-2 text-left text-sm text-app-ink hover:bg-app-hover"
            onClick={() => {
              downloadFragmentFile(title, html);
              setOpen(false);
            }}
            role="menuitem"
            type="button"
          >
            <Icon icon={Download04Icon} size={16} />
            Download file
          </button>
        </div>
      ) : null}
    </div>
  );
}
