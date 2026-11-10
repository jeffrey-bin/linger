import { createServer, request as httpRequest } from "node:http";
import process from "node:process";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import Negotiator from "negotiator";
import sirv from "sirv";

const reservedPathPrefixes = [
  "/api/agent",
  "/assets",
  "/brand",
  "/collaboration",
  "/healthz",
  "/internal",
  "/install",
  "/v0",
];
const supportedContentEncodings = ["br", "gzip", "identity"];
export function createStaticHost({ root } = {}) {
  const staticRoot = root ?? fileURLToPath(new URL("./dist", import.meta.url));
  const serveFiles = sirv(staticRoot, {
    brotli: true,
    etag: true,
    extensions: [],
    gzip: true,
    setHeaders(response, pathname) {
      if (pathname.startsWith("/assets/")) {
        response.setHeader("access-control-allow-origin", "*");
      }
      response.setHeader(
        "cache-control",
        pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  });

  return async function staticHost(request, response) {
    let pathname;
    try {
      pathname = decodeURI(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      response.statusCode = 404;
      response.end();
      return;
    }
    setBrowserSecurityHeaders(response, pathname);

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (pathname === "/healthz") {
      const body = JSON.stringify({
        ok: true,
        service: "linger-web",
      });

      response.statusCode = 200;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    serveNegotiatedFile(serveFiles, request, response, () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!isBrowserNavigation(request, pathname)) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const requestUrl = request.url;
      request.url = "/index.html";
      serveNegotiatedFile(serveFiles, request, response, () => {
        response.statusCode = 404;
        response.end();
      });
      request.url = requestUrl;
    });
  };
}

function serveNegotiatedFile(serveFiles, request, response, onNoMatch) {
  const originalAcceptEncoding = request.headers["accept-encoding"];
  const encoding =
    new Negotiator(request).encoding(supportedContentEncodings, {
      preferred: supportedContentEncodings,
    }) ?? "identity";
  request.headers["accept-encoding"] = encoding === "identity" ? "" : encoding;

  serveFiles(request, response, onNoMatch);

  if (originalAcceptEncoding === undefined) {
    delete request.headers["accept-encoding"];
  } else {
    request.headers["accept-encoding"] = originalAcceptEncoding;
  }
}

function setBrowserSecurityHeaders(response, pathname) {
  const isMermaidRuntime = pathname === "/mermaid-preview-runtime.html";
  response.setHeader(
    "content-security-policy",
    `base-uri 'self'; frame-ancestors ${isMermaidRuntime ? "'self'" : "'none'"}; object-src 'none'`,
  );
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "x-frame-options",
    isMermaidRuntime ? "SAMEORIGIN" : "DENY",
  );
}

function isBrowserNavigation(request, pathname) {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.accept ?? "").includes("text/html") &&
    !isResourceOrServicePath(pathname)
  );
}

function isResourceOrServicePath(pathname) {
  return (
    reservedPathPrefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    ) || extname(pathname) !== ""
  );
}

/**
 * Forwards requests and WebSocket upgrades under each path prefix to its
 * upstream origin; prefixes without an upstream stay with the static host.
 */
/**
 * Upstreams the production host forwards; an unset variable leaves its paths
 * to the static host. TeamHub serves the Agent CLI API; the Agent Service
 * serves the Computer release and the Computer's Runner Gateway, Local MCP
 * Relay and Local Context paths, so a Computer needs only the Web origin.
 */
export function serviceProxyRoutes(environment) {
  const agentService = environment.TEAMHUB_NODE_SERVICES_URL;
  return {
    "/v0": environment.TEAMHUB_BASE_URL,
    "/api/agent": environment.TEAMHUB_BASE_URL,
    "/document-collaboration": environment.TEAMHUB_DOCUMENT_RUNTIME_URL,
    "/install": agentService,
    "/v1/runner-gateway": agentService,
    "/v1/local-mcp-relay": agentService,
    "/v1/context-content": agentService,
  };
}

export function createServiceProxy(routes) {
  const targets = Object.entries(routes)
    .filter(([, target]) => target)
    .map(([prefix, target]) => [prefix, new URL(target)]);
  const targetFor = (url = "/") => {
    const pathname = url.split("?", 1)[0];
    return targets.find(
      ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )?.[1];
  };
  const forward = (request, target) =>
    httpRequest({
      headers: {
        ...request.headers,
        host: target.host,
        "x-forwarded-for": request.socket.remoteAddress ?? "",
      },
      hostname: target.hostname,
      method: request.method,
      path: request.url,
      port: target.port,
    });
  return {
    request(request, response) {
      const target = targetFor(request.url);
      if (!target) return false;
      const upstream = forward(request, target);
      upstream.on("response", (reply) => {
        response.writeHead(
          reply.statusCode,
          reply.statusMessage,
          reply.rawHeaders,
        );
        reply.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.headersSent) response.statusCode = 502;
        response.end();
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
      return true;
    },
    upgrade(request, socket, head) {
      const target = targetFor(request.url);
      if (!target) {
        socket.destroy();
        return;
      }
      const upstream = forward(request, target);
      upstream.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/1.1 101 ${reply.statusMessage}`];
        for (let index = 0; index < reply.rawHeaders.length; index += 2) {
          lines.push(
            `${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`,
          );
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        socket.write(upstreamHead);
        upstreamSocket.write(head);
        upstreamSocket.pipe(socket).pipe(upstreamSocket);
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("close", () => upstreamSocket.destroy());
      });
      // The upstream refused the upgrade: answer with its status and close.
      upstream.on("response", (reply) => {
        reply.resume();
        socket.end(
          `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nconnection: close\r\n\r\n`,
        );
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.end();
    },
  };
}

if (isMainModule()) {
  const port = Number(process.env.PORT ?? 3000);
  const staticHost = createStaticHost();
  // The production bundle calls TeamHub and the Document Runtime on the page
  // origin, so a host with these upstreams forwards them like the Vite proxy.
  const proxy = createServiceProxy(serviceProxyRoutes(process.env));
  const server = createServer((request, response) => {
    if (!proxy.request(request, response)) void staticHost(request, response);
  });
  server.on("upgrade", proxy.upgrade);

  // Native binds loopback only; the container image listens on every address.
  server.listen(port, process.env.HOST || "0.0.0.0", () => {
    process.stdout.write(
      `Web static host listening on http://localhost:${port}\n`,
    );
  });
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return (
    typeof entrypoint === "string" &&
    pathToFileURL(resolve(entrypoint)).href === import.meta.url
  );
}
