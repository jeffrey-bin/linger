export const htmlFragmentSizeMessageType = "linger-html-fragment-size";

function fragmentSizeReporterScript() {
  return `<script>
    (() => {
      let layoutFrame = 0;
      const post = () => {
        const vis = document.getElementById("vis-container");
        const content = document.getElementById("vis-content");
        if (vis && content) {
          const availableWidth = vis.clientWidth;
          const naturalWidth = Math.max(content.scrollWidth, content.offsetWidth);
          const naturalHeight = Math.max(content.scrollHeight, content.offsetHeight);
          const scale = Math.min(1, availableWidth / naturalWidth);
          if (availableWidth > 0 && naturalWidth > 0) {
            content.style.transform = scale < 1 ? \`scale(\${scale})\` : "";
            const scaledHeight = Math.ceil(naturalHeight * scale);
            if (scaledHeight > 0) {
              const nextHeight = \`\${scaledHeight}px\`;
              if (vis.style.height !== nextHeight) vis.style.height = nextHeight;
            }
          }
        }
        // When every outer element caps its width with a px max-width, the
        // fragment reports the widest cap so the frame can hug it; anything
        // fluid reports none and the frame keeps the chat width. Only the
        // declared cap counts, so the frame's own width never feeds back.
        let width = 0;
        if (content) {
          for (const child of content.children) {
            if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
            const style = getComputedStyle(child);
            if (style.display === "none") continue;
            const cap = style.maxWidth.endsWith("px") ? parseFloat(style.maxWidth) : NaN;
            width = Number.isFinite(cap) ? Math.max(width, cap) : Infinity;
          }
        }
        const visRect = vis ? vis.getBoundingClientRect().height : 0;
        const height = Math.ceil(vis ? visRect : Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ));
        parent.postMessage({
          type: "${htmlFragmentSizeMessageType}",
          height,
          width: Number.isFinite(width) && width > 0 ? Math.ceil(width) : null,
        }, "*");
      };
      const schedule = () => {
        if (layoutFrame) cancelAnimationFrame(layoutFrame);
        layoutFrame = requestAnimationFrame(() => {
          layoutFrame = 0;
          post();
        });
      };
      if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(schedule);
        observer.observe(document.documentElement);
        const vis = document.getElementById("vis-container");
        const content = document.getElementById("vis-content");
        if (vis) observer.observe(vis);
        if (content) observer.observe(content);
      }
      requestAnimationFrame(() => requestAnimationFrame(post));
      window.addEventListener("load", post);
      window.addEventListener("resize", schedule);
    })();
  </script>`;
}

function ensureFragmentSizeReporter(html: string) {
  if (html.includes(htmlFragmentSizeMessageType)) return html;
  const script = fragmentSizeReporterScript();
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
}

function isHostedVisDocument(html: string) {
  return /^<!DOCTYPE html/i.test(html) && /id=["']vis-container["']/.test(html);
}

interface HtmlFragmentDocumentParts {
  body: string;
  presentationHead: string;
}

function extractHtmlFragmentDocumentParts(
  html: string,
): HtmlFragmentDocumentParts | null {
  const trimmed = html.trim();
  if (!/^<!DOCTYPE html/i.test(trimmed) && !/<html\b/i.test(trimmed)) {
    return null;
  }
  if (typeof DOMParser !== "function") return null;

  const document = new DOMParser().parseFromString(trimmed, "text/html");
  const presentationHead = Array.from(
    document.head.querySelectorAll('style, link[rel~="stylesheet"]'),
  )
    .map((element) => element.outerHTML)
    .join("\n");

  return {
    body: document.body.innerHTML.trim(),
    presentationHead,
  };
}

export function extractWidgetBody(html: string): string {
  const trimmed = html.trim();
  if (!trimmed || isHostedVisDocument(trimmed)) return trimmed;
  const body = trimmed.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  if (body?.[1] !== undefined) return body[1].trim();
  return trimmed;
}

/**
 * The variables an Agent's HTML fragment styles itself with, so it matches the
 * chat and follows the app's theme instead of hard-coding colors. Each takes
 * the value of the app token beside it when the fragment renders; the
 * fallback is used where no app stylesheet is loaded (tests, exports).
 */
const fragmentThemeTokens = [
  ["--color-text-primary", "--app-ink", "#1a1a17"],
  ["--color-text-secondary", "--app-body", "#414038"],
  ["--color-text-tertiary", "--app-muted", "#726f66"],
  ["--color-background-primary", "--app-surface", "#ffffff"],
  ["--color-background-secondary", "--app-surface-soft", "#f4f4f0"],
  ["--color-border-secondary", "--app-border-strong", "rgba(30, 30, 29, 0.18)"],
  ["--color-border-tertiary", "--app-border", "#ecece9"],
  ["--color-accent", "--app-accent", "#262626"],
  ["--color-text-info", "--app-link", "#184f95"],
  ["--color-text-success", "--app-status-success-text", "#265b19"],
  ["--color-text-warning", "--app-status-warning-text", "#5a4815"],
  ["--color-text-danger", "--app-status-danger-text", "#7f2c28"],
  ["--color-on-accent", "--app-action-foreground", "#ffffff"],
  ["--color-focus", "--app-ring", "rgba(38, 38, 38, 0.4)"],
  ["--shadow", "--app-card-shadow", "0 1px 2px rgba(0, 0, 0, 0.04)"],
  [
    "--font-sans",
    "--app-font-sans",
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  ],
  ["--border-radius", "--app-card-radius", "12px"],
] as const;

export type FragmentTheme = Record<
  (typeof fragmentThemeTokens)[number][0],
  string
>;

export const defaultFragmentTheme = Object.fromEntries(
  fragmentThemeTokens.map(([name, , fallback]) => [name, fallback]),
) as FragmentTheme;

/** The fragment variables as the app's stylesheet currently resolves them. */
export function currentFragmentTheme(
  root: Element = document.documentElement,
): FragmentTheme {
  const style = getComputedStyle(root);
  return Object.fromEntries(
    fragmentThemeTokens.map(([name, token, fallback]) => [
      name,
      style.getPropertyValue(token).trim() || fallback,
    ]),
  ) as FragmentTheme;
}

/**
 * The app's own font faces as CSS, with absolute URLs, so a fragment's frame
 * (a separate document) loads the same font the chat uses.
 */
export function appFontFaces(root: Document = document): string {
  const faces: string[] = [];
  for (const sheet of Array.from(root.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href ?? root.baseURI;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      if (!/geist/i.test(rule.style.getPropertyValue("font-family"))) continue;
      faces.push(
        rule.cssText.replace(
          /url\((['"]?)([^'")]+)\1\)/g,
          (_match, quote: string, url: string) =>
            `url(${quote}${new URL(url, base).href}${quote})`,
        ),
      );
    }
  }
  return faces.join("\n");
}

function fragmentThemeDeclarations(theme: FragmentTheme): string {
  return [
    "      color-scheme: light;",
    ...Object.entries(theme).map(
      // A value never closes the declaration or the style element.
      ([name, value]) => `      ${name}: ${value.replace(/[;{}<>]/g, "")};`,
    ),
  ].join("\n");
}

export function wrapHtmlFragment(
  body: string,
  presentationHead = "",
  theme: FragmentTheme = defaultFragmentTheme,
  fontFaces = "",
): string {
  const widget = body.trim();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${presentationHead}
  ${fontFaces ? `<style>${fontFaces}</style>` : ""}
  <style>
    :root {
${fragmentThemeDeclarations(theme)}
    }
    button, input, select, textarea {
      font: inherit;
      color: inherit;
      letter-spacing: inherit;
    }
    html, body {
      margin: 0;
      width: 100%;
      overflow: hidden;
      background: transparent;
      color: var(--color-text-primary);
      font-family: var(--font-sans);
      /* Chat body size, so text the fragment does not size reads like the chat. */
      font-size: 15px;
      line-height: 1.5;
    }
    #vis-container {
      width: 100%;
      position: relative;
      overflow: hidden;
      border-radius: var(--border-radius);
      background: var(--color-background-primary);
    }
    #vis-content {
      width: 100%;
      transform-origin: top left;
    }
    /* The frame grows with the fragment, so an outer element never fixes its
       height (100vh would chase the frame) or scrolls inside it. */
    #vis-content > :not(style):not(script) {
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
    #vis-container > svg,
    #vis-content > svg {
      display: block;
      width: 100%;
      max-width: 100%;
      height: auto;
      margin-inline: auto;
      overflow: visible;
    }
    #vis-container[data-placeholder="true"]::before {
      content: "";
      display: block;
      height: 8px;
      margin: 16px;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        var(--color-border-tertiary) 0%,
        var(--color-background-secondary) 50%,
        var(--color-border-tertiary) 100%
      );
      background-size: 200% 100%;
      animation: vis-placeholder 1.4s ease-in-out infinite;
    }
    @keyframes vis-placeholder {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      #vis-container[data-placeholder="true"]::before {
        animation: none;
      }
    }
  </style>
</head>
<body>
  <div id="vis-container"${widget ? "" : ' data-placeholder="true"'}><div id="vis-content">${widget}</div></div>
  ${fragmentSizeReporterScript()}
</body>
</html>
`;
}

export function hostedHtmlDocument(body: string): string {
  const trimmed = body.trim();
  if (
    /^<!DOCTYPE html/i.test(trimmed) ||
    /id=["']vis-container["']/.test(trimmed)
  ) {
    return ensureFragmentSizeReporter(body);
  }
  return wrapHtmlFragment(body);
}

export function hostedFragmentDocument(
  body: string,
  theme: FragmentTheme = defaultFragmentTheme,
  fontFaces = "",
): string {
  const trimmed = body.trim();
  if (
    isHostedVisDocument(trimmed) ||
    /id=["']vis-container["']/.test(trimmed)
  ) {
    return ensureFragmentSizeReporter(body);
  }
  const documentParts = extractHtmlFragmentDocumentParts(trimmed);
  if (documentParts) {
    return wrapHtmlFragment(
      documentParts.body,
      documentParts.presentationHead,
      theme,
      fontFaces,
    );
  }
  return wrapHtmlFragment(extractWidgetBody(body), "", theme, fontFaces);
}

export function fragmentDownloadFileName(title: string, html: string): string {
  const isSvg = /^\s*<svg[\s>]/i.test(html);
  const stem =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "visual-fragment";
  return `${stem}.${isSvg ? "svg" : "html"}`;
}
