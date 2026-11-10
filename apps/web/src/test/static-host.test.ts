import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createServiceProxy,
  createStaticHost,
  serviceProxyRoutes,
} from "../../static-host.mjs";

let baseUrl: string;
let fixtureRoot: string;
let server: Server;
const serveHost = (host: ReturnType<typeof createStaticHost>) =>
  createServer((request, response) => {
    void host(request, response);
  });
const indexDocument =
  '<!doctype html><html><body><div id="root">Linger</div></body></html>';
const productionScript = 'console.log("Linger production asset");'.repeat(80);

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "linger-static-host-"));
  await mkdir(join(fixtureRoot, "assets"));
  await mkdir(join(fixtureRoot, "brand"));
  await writeFile(join(fixtureRoot, "index.html"), indexDocument);
  await writeFile(join(fixtureRoot, "index.html.br"), brotli(indexDocument));
  await writeFile(join(fixtureRoot, "index.html.gz"), gzip(indexDocument));
  await writeFile(
    join(fixtureRoot, "mermaid-preview-runtime.html"),
    "<!doctype html><title>Mermaid runtime</title>",
  );
  await writeFile(
    join(fixtureRoot, "assets", "app-abc123.js"),
    productionScript,
  );
  await writeFile(
    join(fixtureRoot, "assets", "app-abc123.js.br"),
    brotli(productionScript),
  );
  await writeFile(
    join(fixtureRoot, "assets", "app-abc123.js.gz"),
    gzip(productionScript),
  );
  await writeFile(join(fixtureRoot, "brand", "logo.png"), "brand");
  server = serveHost(createStaticHost({ root: fixtureRoot }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Static host did not bind to a TCP port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("Web static host routing", () => {
  it.each(["/%", "/%E0%A4%A"])(
    "rejects malformed URI %s without crashing",
    async (requestPath) => {
      expect((await fetch(`${baseUrl}${requestPath}`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    },
  );

  it.each([
    "/",
    "/login",
    "/t/tenant-1/rooms",
    "/t/tenant-1/rooms/room-1/chat",
    "/t/tenant-1/rooms/room-1/chat",
    "/t/tenant-1/apps",
    "/t/tenant-1/settings",
    "/t/tenant-1/settings/account",
    "/t/tenant-1/settings/security",
    "/t/tenant-1/library/wiki",
    "/documents",
    "/documents/native_document_1",
    "/native-document-ai",
    "/not-a-web-route",
    "/workspaces/default/summary",
  ])("serves the SPA document for Browser History route %s", async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        connection: "close",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('id="root"');
  });

  it("exposes an independent non-HTML health response", async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { connection: "close" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "linger-web",
    });
  });

  it.each([
    "/assets",
    "/assets/missing.js",
    "/brand",
    "/brand/missing.png",
    "/collaboration",
    "/collaboration/document-1",
    "/internal/v0/documents/document-1/state",
    "/v0",
    "/v0/session",
    "/healthz/missing",
  ])("does not rewrite non-SPA resource path %s", async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: "text/html", connection: "close" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain(
      "text/html",
    );
  });

  it("does not serve static files for non-read methods", async () => {
    const response = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      body: "not-a-static-read",
      headers: { accept: "text/html", connection: "close" },
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("does not rewrite non-browser requests to the SPA", async () => {
    const response = await fetch(`${baseUrl}/t/tenant-1/rooms/room-1/chat`, {
      headers: { accept: "application/json", connection: "close" },
    });

    expect(response.status).toBe(404);
  });

  it("supports HEAD requests for eligible Browser History navigation", async () => {
    const response = await fetch(`${baseUrl}/t/tenant-1/rooms/room-1/chat`, {
      headers: { accept: "text/html", connection: "close" },
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toBe("");
  });
});

describe("Web static host cache policy", () => {
  it("serves fingerprinted Vite assets with immutable caching", async () => {
    const response = await fetch(`${baseUrl}/assets/app-abc123.js`, {
      headers: { connection: "close" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps the SPA document revalidatable", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      headers: { accept: "text/html", connection: "close" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("keeps non-fingerprinted public assets revalidatable", async () => {
    const response = await fetch(`${baseUrl}/brand/logo.png`, {
      headers: { connection: "close" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("Web static host content negotiation", () => {
  it.each([
    {
      acceptEncoding: "gzip, br",
      contentEncoding: "br",
      contentLength: () => brotli(productionScript).length,
    },
    {
      acceptEncoding: "gzip",
      contentEncoding: "gzip",
      contentLength: () => gzip(productionScript).length,
    },
    {
      acceptEncoding: "br;q=0, gzip",
      contentEncoding: "gzip",
      contentLength: () => gzip(productionScript).length,
    },
    {
      acceptEncoding: "gzip;q=1, br;q=0.5",
      contentEncoding: "gzip",
      contentLength: () => gzip(productionScript).length,
    },
    {
      acceptEncoding: "br;q=0, gzip;q=0",
      contentEncoding: null,
      contentLength: () => Buffer.byteLength(productionScript),
    },
    {
      acceptEncoding: "identity",
      contentEncoding: null,
      contentLength: () => Buffer.byteLength(productionScript),
    },
  ])(
    "serves $contentEncoding when the browser accepts $acceptEncoding",
    async ({ acceptEncoding, contentEncoding, contentLength }) => {
      const response = await fetch(`${baseUrl}/assets/app-abc123.js`, {
        headers: {
          "accept-encoding": acceptEncoding,
          connection: "close",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe(contentEncoding);
      expect(response.headers.get("content-length")).toBe(
        String(contentLength()),
      );
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(response.headers.get("vary")?.split(/,\s*/)).toContain(
        "Accept-Encoding",
      );
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      await expect(response.text()).resolves.toBe(productionScript);
    },
  );

  it("negotiates the SPA fallback without changing its HTML or cache contract", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      headers: {
        accept: "text/html",
        "accept-encoding": "br, gzip",
        connection: "close",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    await expect(response.text()).resolves.toBe(indexDocument);
  });

  it.each(["/healthz", "/brand/logo.png", "/assets/missing.js"])(
    "does not invent a compressed representation for %s",
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          accept: "text/html",
          "accept-encoding": "br, gzip",
          connection: "close",
        },
      });

      expect(response.headers.get("content-encoding")).toBeNull();
    },
  );
});

describe("Web static host security policy", () => {
  it.each(["/login", "/assets/app-abc123.js"])(
    "adds baseline browser security headers to %s",
    async (path) => {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { accept: "text/html", connection: "close" },
      });

      expect(response.headers.get("content-security-policy")).toBe(
        "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
      );
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it("allows only the isolated Mermaid runtime to be framed by this origin", async () => {
    const response = await fetch(`${baseUrl}/mermaid-preview-runtime.html`, {
      headers: { accept: "text/html", connection: "close" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "base-uri 'self'; frame-ancestors 'self'; object-src 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("Web service proxy", () => {
  it("forwards the Computer paths to their services only when configured", () => {
    const agent = "http://node-services:4319";
    const routes = serviceProxyRoutes({
      TEAMHUB_NODE_SERVICES_URL: agent,
      TEAMHUB_BASE_URL: "http://teamhub:8080",
    });
    for (const prefix of [
      "/install",
      "/v1/runner-gateway",
      "/v1/local-mcp-relay",
      "/v1/context-content",
    ])
      expect(routes[prefix as keyof typeof routes], prefix).toBe(agent);
    expect(routes["/v0"]).toBe("http://teamhub:8080");
    // The teamhub CLI on a Computer calls TeamHub on the Web origin.
    expect(routes["/api/agent"]).toBe("http://teamhub:8080");
    expect(
      Object.values(serviceProxyRoutes({})).every(
        (target) => target === undefined,
      ),
    ).toBe(true);
  });

  it("forwards HTTP requests and WebSocket upgrades to the configured upstream", async () => {
    const upstream = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("set-cookie", ["a=1", "b=2"]);
        response.end(
          JSON.stringify({
            body,
            host: request.headers.host,
            method: request.method,
            url: request.url,
          }),
        );
      });
    });
    upstream.on("upgrade", (request, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (chunk) =>
        socket.write(`echo:${request.url}:${chunk}`),
      );
      socket.on("end", () => socket.end());
    });
    const upstreamPort = await listen(upstream);
    const proxy = createServiceProxy({
      "/document-collaboration": undefined,
      "/v0": `http://127.0.0.1:${upstreamPort}`,
    });
    const host = createServer((request, response) => {
      if (!proxy.request(request, response)) {
        response.statusCode = 418;
        response.end();
      }
    });
    host.on("upgrade", proxy.upgrade);
    const port = await listen(host);
    try {
      const forwarded = await fetch(`http://127.0.0.1:${port}/v0/rooms?x=1`, {
        body: "payload",
        headers: { connection: "close" },
        method: "POST",
      });
      expect(forwarded.status).toBe(200);
      expect(forwarded.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      expect(await forwarded.json()).toEqual({
        body: "payload",
        host: `127.0.0.1:${upstreamPort}`,
        method: "POST",
        url: "/v0/rooms?x=1",
      });

      for (const path of ["/document-collaboration", "/v0rooms", "/"]) {
        const local = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { connection: "close" },
        });
        expect(local.status).toBe(418);
      }

      const socket = connect(port, "127.0.0.1");
      const received = new Promise<string>((resolve) => {
        let text = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          text += chunk;
          if (text.includes("echo:")) resolve(text);
        });
      });
      socket.write(
        "GET /v0/events HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\nhello",
      );
      const text = await received;
      socket.destroy();
      expect(text.startsWith("HTTP/1.1 101 ")).toBe(true);
      expect(text).toContain("echo:/v0/events:hello");
    } finally {
      host.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([close(host), close(upstream)]);
    }
  });
});

async function listen(target: Server) {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const address = target.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port.");
  }
  return address.port;
}

function close(target: Server) {
  return new Promise<void>((resolve, reject) => {
    target.close((error) => (error ? reject(error) : resolve()));
  });
}

function brotli(source: string) {
  return brotliCompressSync(source);
}

function gzip(source: string) {
  return gzipSync(source, { level: 9 });
}
