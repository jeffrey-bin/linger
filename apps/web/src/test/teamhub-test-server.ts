import type { TeamHubApiPath } from "@/features/teamhub/teamhub-api";

export type TestRouteMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface TestRouteRequest {
  /** The JSON or text body; undefined for an empty or multipart body. */
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
  request: Request;
}

/**
 * Answers one request, directly or as a promise. A Response is sent as is,
 * undefined becomes 204, and any other value is sent as a 200 JSON body.
 */
export type TestRouteHandler = (request: TestRouteRequest) => unknown;

interface TestRoute {
  handler: TestRouteHandler;
  method: TestRouteMethod;
  names: string[];
  pattern: RegExp;
}

/** A TeamHub error envelope response, as TeamHub writes it. */
export function teamHubErrorResponse(
  status: number,
  code: string,
  message = code,
  details?: Record<string, unknown>,
) {
  return Response.json(
    {
      error: {
        code,
        message,
        request_id: `test-${code.toLowerCase()}`,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

const liveServers = new Set<TeamHubTestServer>();

/**
 * Fails the current test when a server it created answered a request without
 * a route. Callers often swallow request errors (background refreshes,
 * subscriptions), so the 501 alone would let a test that misses a route pass.
 */
export function assertNoUnhandledTestRoutes() {
  const missing = [...liveServers].flatMap((server) =>
    server.unhandledAllowed ? [] : server.unhandled,
  );
  liveServers.clear();
  if (missing.length)
    throw new Error(`Requests without a test route: ${missing.join(", ")}`);
}

/**
 * An in-process TeamHub HTTP boundary for unit tests. Tests declare the
 * responses they depend on with `on`; a later route for the same method and
 * path wins. A request without a route gets a 501 error envelope, is
 * recorded in `unhandled`, and fails the test unless it called
 * `allowUnhandledRoutes`.
 */
export class TeamHubTestServer {
  readonly requests: Request[] = [];
  readonly unhandled: string[] = [];
  unhandledAllowed = false;
  #routes: TestRoute[] = [];

  constructor() {
    liveServers.add(this);
  }

  /** For tests that assert the client's handling of a missing route. */
  allowUnhandledRoutes(): this {
    this.unhandledAllowed = true;
    return this;
  }

  on(
    method: TestRouteMethod,
    path: TeamHubApiPath,
    handler: TestRouteHandler,
  ): this {
    const names: string[] = [];
    const source = path
      .split(/(\{[^}]+\})/u)
      .map((part) => {
        const name = /^\{([^}]+)\}$/u.exec(part)?.[1];
        if (name === undefined)
          return part.replace(/[.*+?^$()|[\]\\]/gu, "\\$&");
        names.push(name);
        return "([^/]+)";
      })
      .join("");
    this.#routes.push({
      handler,
      method,
      names,
      pattern: new RegExp(`^${source}$`, "u"),
    });
    return this;
  }

  /** Returns every recorded request to one method and path. */
  requestsTo(method: TestRouteMethod, path: TeamHubApiPath) {
    const pattern = new RegExp(
      `^${path.replace(/\{[^}]+\}/gu, "[^/]+")}$`,
      "u",
    );
    return this.requests.filter(
      (request) =>
        request.method === method &&
        pattern.test(new URL(request.url).pathname),
    );
  }

  fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    this.requests.push(request.clone());
    const url = new URL(request.url);
    for (let index = this.#routes.length - 1; index >= 0; index -= 1) {
      const route = this.#routes[index]!;
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(
        route.names.map((name, position) => [
          name,
          decodeURIComponent(match[position + 1]!),
        ]),
      );
      const result = await route.handler({
        body: await readBody(request.clone()),
        params,
        query: url.searchParams,
        request,
      });
      request.signal.throwIfAborted();
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return Response.json(result);
    }
    this.unhandled.push(`${request.method} ${url.pathname}`);
    return teamHubErrorResponse(
      501,
      "TEST_ROUTE_MISSING",
      `No test route for ${request.method} ${url.pathname}`,
    );
  };

  /** Sends XMLHttpRequest uploads through the same routes. */
  xhrFactory = () =>
    new TestXmlHttpRequest(this.fetch) as unknown as XMLHttpRequest;
}

async function readBody(request: Request) {
  if (!request.body) return undefined;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return request.json();
  // jsdom Files do not survive the Fetch multipart parser; upload handlers
  // that inspect the form read it from the request themselves.
  if (type.includes("multipart/form-data")) return undefined;
  const text = await request.text();
  return text === "" ? undefined : text;
}

class TestXmlHttpRequest {
  onabort: ((event: ProgressEvent) => void) | null = null;
  onerror: ((event: ProgressEvent) => void) | null = null;
  onload: ((event: ProgressEvent) => void) | null = null;
  ontimeout: ((event: ProgressEvent) => void) | null = null;
  responseText = "";
  status = 0;
  timeout = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  withCredentials = false;
  #controller = new AbortController();
  #fetch: typeof fetch;
  #headers = new Headers();
  #method = "GET";
  #url = "";

  constructor(fetchRequest: typeof fetch) {
    this.#fetch = fetchRequest;
  }

  open(method: string, url: string) {
    this.#method = method;
    this.#url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.#headers.set(name, value);
  }

  abort() {
    this.#controller.abort();
    this.onabort?.({ type: "abort" } as ProgressEvent);
  }

  send(body: XMLHttpRequestBodyInit | null) {
    void this.#fetch(this.#url, {
      body,
      headers: this.#headers,
      method: this.#method,
      signal: this.#controller.signal,
    }).then(
      async (response) => {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 1,
        } as ProgressEvent);
        this.status = response.status;
        this.responseText = await response.text();
        this.onload?.({ type: "load" } as ProgressEvent);
      },
      () => {
        if (!this.#controller.signal.aborted)
          this.onerror?.({ type: "error" } as ProgressEvent);
      },
    );
  }
}
