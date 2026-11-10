import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";

import { isDesktopShell } from "@/app/desktop-shell";
import { Icon } from "@/components/ui/icon";

import { shouldOpenUrlExternally } from "../url-preview-policy";

const previewSandbox = "allow-forms allow-scripts";

// The development server proxies previews, so its frames share the app's
// origin and get no storage. The desktop app lets sites be framed directly
// (its window drops their frame refusals), even when it runs a development
// server on this computer.
function previewProxied() {
  return import.meta.env.DEV && !isDesktopShell();
}

function previewFrameSrc(url: string) {
  if (!previewProxied()) return url;
  return `/__panel_url_preview?url=${encodeURIComponent(url)}`;
}

function safePreviewUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    return normalizePreviewUrl(value);
  } catch {
    return undefined;
  }
}

function normalizePreviewUrl(value: string) {
  const input = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Enter a valid HTTP(S) URL without credentials.");
  }
  return url.href;
}

export function UrlPreviewPanel({
  hidden = false,
  url,
}: {
  hidden?: boolean;
  url?: string;
}) {
  return (
    <UrlPreviewSession
      hidden={hidden}
      key={safePreviewUrl(url) ?? "home"}
      url={url}
    />
  );
}

function UrlPreviewSession({
  hidden = false,
  url,
}: {
  hidden?: boolean;
  url?: string;
}) {
  const initialUrl = safePreviewUrl(url);
  const [history, setHistory] = useState<string[]>(
    initialUrl ? [initialUrl] : [],
  );
  const [index, setIndex] = useState(initialUrl ? 0 : -1);
  const [address, setAddress] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const currentUrl = history[index];
  const externalOnly = currentUrl
    ? shouldOpenUrlExternally(new URL(currentUrl))
    : false;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "linger-preview-navigate" || !data.url) return;
      navigate(data.url, false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  function navigate(value: string, fromUser = true) {
    try {
      const url = normalizePreviewUrl(value);
      if (fromUser && shouldOpenUrlExternally(new URL(url))) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      const next = [...history.slice(0, index + 1), url];
      setHistory(next);
      setIndex(next.length - 1);
      setAddress(url);
      setError(null);
    } catch {
      setError("Enter a valid HTTP(S) URL without credentials.");
    }
  }

  function move(nextIndex: number) {
    const url = history[nextIndex];
    if (!url) return;
    setIndex(nextIndex);
    setAddress(url);
    setError(null);
  }

  return (
    <section
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-card px-2">
        <button
          aria-label="Back"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={index <= 0}
          onClick={() => move(index - 1)}
          type="button"
        >
          <Icon icon={ArrowLeft01Icon} size={16} />
        </button>
        <button
          aria-label="Forward"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={index < 0 || index >= history.length - 1}
          onClick={() => move(index + 1)}
          type="button"
        >
          <Icon icon={ArrowRight01Icon} size={16} />
        </button>
        <button
          aria-label="Reload"
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          disabled={!currentUrl || externalOnly}
          onClick={() => setReloadKey((value) => value + 1)}
          type="button"
        >
          <Icon icon={RotateClockwiseIcon} size={14} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <label className="sr-only" htmlFor="panel-url-address">
            URL address
          </label>
          <div>
            <input
              aria-invalid={Boolean(error)}
              className="h-8 w-full rounded-lg border border-transparent bg-transparent px-2 text-center text-xs text-muted-foreground outline-none transition-colors hover:bg-muted/50 focus:border-input focus:bg-card focus:text-foreground"
              id="panel-url-address"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Enter URL"
              spellCheck={false}
              value={address}
            />
          </div>
        </form>
        {currentUrl ? (
          <a
            aria-label="Open in new tab"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            href={currentUrl}
            rel="noopener noreferrer"
            target="_blank"
            title="Open in new tab"
          >
            <Icon icon={ArrowUpRight01Icon} size={16} />
          </a>
        ) : null}
      </div>
      {error ? (
        <p
          className="border-b border-(--app-status-danger-border) bg-(--app-status-danger-surface) px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 bg-card">
        {!currentUrl ? (
          <p className="p-4 text-sm text-muted-foreground">
            Enter a URL to preview.
          </p>
        ) : externalOnly ? (
          <p className="p-4 text-sm text-muted-foreground">
            Open this address in a browser tab to view it.
          </p>
        ) : (
          <iframe
            className="h-full w-full border-0 bg-white"
            key={`${currentUrl}:${reloadKey}`}
            ref={frameRef}
            sandbox={
              previewProxied()
                ? previewSandbox
                : `${previewSandbox} allow-same-origin`
            }
            src={previewFrameSrc(currentUrl)}
            title={`Preview ${currentUrl}`}
          />
        )}
      </div>
    </section>
  );
}
