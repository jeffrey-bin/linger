const PREVIEW_PATH = "/__panel_url_preview";
const MAX_HTML_BYTES = 2_000_000;

const navigationScript = `(function () {
  function report(value, base) {
    try {
      var next = new URL(String(value), base);
      if (next.protocol !== "http:" && next.protocol !== "https:") return;
      parent.postMessage({ type: "linger-preview-navigate", url: next.href }, "*");
    } catch (error) {}
  }
  var base = document.baseURI;
  document.addEventListener("click", function (event) {
    var node = event.target;
    var anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor) return;
    var next;
    try { next = new URL(anchor.href, base); } catch (error) { return; }
    if (next.protocol !== "http:" && next.protocol !== "https:") return;
    if (next.href.split("#")[0] === base.split("#")[0] && next.hash) return;
    event.preventDefault();
    event.stopPropagation();
    parent.postMessage({ type: "linger-preview-navigate", url: next.href }, "*");
  }, true);
  window.open = function (url) {
    if (url) report(url, base);
    return null;
  };
})();`;

export function panelPreviewTarget(requestUrl) {
  const url = new URL(requestUrl ?? "/", "http://localhost");
  if (url.pathname !== PREVIEW_PATH) return null;
  const target = url.searchParams.get("url");
  if (!target) return null;
  const parsed = new URL(target);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Preview only accepts HTTP(S) URLs without credentials.");
  }
  return parsed.href;
}

export function rewritePreviewHtml(html, pageUrl) {
  const base = pageUrl.replace(/"/g, "&quot;");
  const injection =
    `<base href="${base}">` + `<script>${navigationScript}</script>`;
  const withoutPolicy = html.replace(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    "",
  );
  if (/<head[^>]*>/i.test(withoutPolicy)) {
    return withoutPolicy.replace(
      /<head[^>]*>/i,
      (match) => `${match}${injection}`,
    );
  }
  return `${injection}${withoutPolicy}`;
}

export function panelUrlPreviewPlugin() {
  return {
    name: "linger-panel-url-preview",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let target;
        try {
          target = panelPreviewTarget(request.url);
        } catch {
          response.statusCode = 400;
          response.end("Invalid preview URL.");
          return;
        }
        if (!target) {
          next();
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.end("Method not allowed.");
          return;
        }
        try {
          const upstream = await fetch(target, {
            headers: { accept: "text/html,application/xhtml+xml,*/*" },
            redirect: "follow",
          });
          if (!upstream.ok) {
            response.statusCode = upstream.status;
            response.setHeader("cache-control", "no-store");
            response.end("Preview could not load that URL.");
            return;
          }
          const pageUrl = upstream.url || target;
          const contentType =
            upstream.headers.get("content-type") ?? "application/octet-stream";
          if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
            const bytes = Buffer.from(await upstream.arrayBuffer());
            response.statusCode = upstream.status;
            response.setHeader("content-type", contentType);
            response.setHeader("cache-control", "no-store");
            response.end(request.method === "HEAD" ? undefined : bytes);
            return;
          }
          const html = await upstream.text();
          if (html.length > MAX_HTML_BYTES) {
            response.statusCode = 502;
            response.end("Preview page is too large.");
            return;
          }
          const body = rewritePreviewHtml(html, pageUrl);
          response.statusCode = upstream.ok ? 200 : upstream.status;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(request.method === "HEAD" ? undefined : body);
        } catch {
          response.statusCode = 502;
          response.setHeader("cache-control", "no-store");
          response.end("Preview could not load that URL.");
        }
      });
    },
  };
}
