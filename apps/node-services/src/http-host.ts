import type { Server } from "node:http";

import { createAdaptorServer } from "@hono/node-server";

export type RoleReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

/** One role's share of the process HTTP listener. */
export interface HttpRoute {
  /** Path prefixes this role answers; the longest matching prefix wins. */
  readonly prefixes: readonly string[];
  fetch(request: Request): Response | Promise<Response>;
  /** Contributes to the aggregate /readyz; omitted means always ready. */
  readiness?(): RoleReadiness | Promise<RoleReadiness>;
}

/**
 * The single HTTP listener that the Agent, Memory, and LLM Wiki roles share. It
 * owns the aggregate probes /healthz, /startupz, and /readyz
 * and routes every other request to the role that mounted its path prefix.
 */
export interface HttpHost {
  /** The Node server, for roles that also accept WebSocket upgrades. */
  readonly server: Server;
  /** The configured bind address. */
  readonly host: string;
  readonly port: number;
  /** This listener's own URL; a wildcard bind address becomes loopback. */
  readonly url: string;
  /** Routes the given prefixes to a role; the returned function unmounts it. */
  mount(route: HttpRoute): () => void;
  /**
   * Ends startup: /startupz and /readyz stop answering "starting", and paths
   * that no role mounted answer 404 instead of 503.
   */
  finishStartup(): void;
  close(): Promise<void>;
}

const PROBES = new Set(["/healthz", "/startupz", "/readyz"]);

/** Listens on host:port and resolves once the TCP address is bound. */
export async function startHttpHost(options: {
  host: string;
  port: number;
}): Promise<HttpHost> {
  const routes: { prefix: string; route: HttpRoute }[] = [];
  let starting = true;
  const routeFor = (path: string): HttpRoute | undefined => {
    let match: { prefix: string; route: HttpRoute } | undefined;
    for (const candidate of routes) {
      if (
        path.startsWith(candidate.prefix) &&
        candidate.prefix.length > (match?.prefix.length ?? -1)
      ) {
        match = candidate;
      }
    }
    return match?.route;
  };
  const readiness = async (): Promise<RoleReadiness> => {
    if (starting) return { ready: false, reason: "starting" };
    const mounted = new Set(routes.map(({ route }) => route));
    for (const route of mounted) {
      let result: RoleReadiness;
      try {
        result = (await route.readiness?.()) ?? { ready: true };
      } catch {
        result = { ready: false, reason: "dependency_check_failed" };
      }
      if (!result.ready) return result;
    }
    return { ready: true };
  };
  const probe = async (path: string): Promise<Response> => {
    if (path === "/healthz") return Response.json({ status: "ok" });
    if (path === "/startupz") {
      return starting
        ? Response.json({ status: "starting" }, { status: 503 })
        : Response.json({ status: "ok" });
    }
    const result = await readiness();
    return result.ready
      ? Response.json({ status: "ok" })
      : Response.json(
          { reason: result.reason, status: "not_ready" },
          { status: 503 },
        );
  };
  const dispatch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (PROBES.has(path)) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: { allow: "GET" } });
      }
      return probe(path);
    }
    const route = routeFor(path);
    if (route) return route.fetch(request);
    if (starting) {
      return Response.json(
        {
          error: {
            code: "SERVICE_NOT_READY",
            message: "Node Services is starting",
          },
        },
        { status: 503 },
      );
    }
    return new Response(null, { status: 404 });
  };
  const server = createAdaptorServer({
    fetch: dispatch,
    hostname: options.host,
    // Roles on the main thread must not replace process globals.
    overrideGlobalObjects: false,
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("HTTP server did not receive a TCP address");
  }
  const host = options.host;
  // A wildcard listener is reached through loopback from this machine.
  const urlHost =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return {
    server,
    host,
    port: address.port,
    url: `http://${urlHost.includes(":") ? `[${urlHost}]` : urlHost}:${address.port}`,
    mount(route) {
      for (const prefix of route.prefixes) {
        if (!prefix.startsWith("/") || PROBES.has(prefix)) {
          throw new TypeError(`Invalid HTTP route prefix: ${prefix}`);
        }
        if (routes.some((mounted) => mounted.prefix === prefix)) {
          throw new TypeError(`HTTP route prefix already mounted: ${prefix}`);
        }
      }
      const entries = route.prefixes.map((prefix) => ({ prefix, route }));
      routes.push(...entries);
      return () => {
        for (const entry of entries) {
          const index = routes.indexOf(entry);
          if (index >= 0) routes.splice(index, 1);
        }
      };
    },
    finishStartup() {
      starting = false;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Reads a request body, stopping as soon as it exceeds `maxBytes`. Returns
 * undefined when the limit is exceeded.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, sizeBytes);
    sizeBytes += value.byteLength;
    if (sizeBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
}
