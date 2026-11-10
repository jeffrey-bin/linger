import createClient, {
  createFinalURL,
  createQuerySerializer,
  defaultPathSerializer,
  type Client,
  type Middleware,
} from "openapi-fetch";
import type { paths } from "@linger/wire-contracts/teamhub-public/types";

import type { TeamHubAuthenticationReason } from "./teamhub-authentication";
import { readTeamHubError, TeamHubTransportError } from "./teamhub-error";

/** The TeamHub public API, typed by the generated contract `paths`. */
export type TeamHubApi = Client<paths>;
export type TeamHubApiPath = keyof paths;

// Signing in, reading the Session, and opening a shared link decide
// authentication themselves, so a 401 there is an answer, not a lost Session.
const unauthenticatedPaths = new Set<TeamHubApiPath>([
  "/v0/auth/login",
  "/v0/session",
  "/v0/shared-documents/content",
  "/v0/shared-documents/resolve",
  "/v0/shared-room-history/asset",
  "/v0/shared-room-history/read",
]);

/**
 * Creates the one typed TeamHub client: it sends the Session cookie, maps a
 * non-2xx response to TeamHubError (reporting a lost Session on 401), and
 * maps a request that never got a response to TeamHubTransportError.
 */
export function createTeamHubApi(options: {
  baseUrl: URL;
  fetchRequest: typeof fetch;
  onAuthenticationRequired: (reason: TeamHubAuthenticationReason) => void;
}): TeamHubApi {
  const { fetchRequest, onAuthenticationRequired } = options;
  const api = createClient<paths>({
    baseUrl: options.baseUrl.href,
    credentials: "include",
    fetch: (request) => fetchRequest(request),
  });
  const errors: Middleware = {
    async onResponse({ request, response, schemaPath }) {
      if (response.ok) return undefined;
      const error = await readTeamHubError(response);
      request.signal.throwIfAborted();
      if (
        response.status === 401 &&
        !unauthenticatedPaths.has(schemaPath as TeamHubApiPath)
      ) {
        onAuthenticationRequired("session-expired");
      }
      throw error;
    },
    onError({ error }) {
      if (error instanceof Error && error.name === "AbortError") return error;
      return new TeamHubTransportError(
        "TeamHub request failed before receiving a response.",
      );
    },
  };
  api.use(errors);
  return api;
}

/**
 * Resolves a successful JSON call to its body. The error middleware has
 * already thrown for every non-2xx response.
 */
export function teamHubData<T>(call: Promise<{ data?: T }>): Promise<T> {
  return call.then(({ data }) => data as T);
}

/** Resolves a successful call that has no body to read. */
export function teamHubDone(call: Promise<unknown>): Promise<void> {
  return call.then(() => undefined);
}

export function idempotencyHeader(idempotencyKey: string) {
  return { "Idempotency-Key": idempotencyKey };
}

type PathParameters<Path extends TeamHubApiPath> = paths[Path] extends {
  parameters: { path: infer Parameters };
}
  ? Parameters
  : never;

/**
 * Builds the URL of a contract path for transports openapi-fetch does not
 * cover: EventSource streams, XMLHttpRequest uploads, and bounded downloads.
 */
export function teamHubUrl<Path extends TeamHubApiPath>(
  baseUrl: URL,
  path: Path,
  ...[parameters]: PathParameters<Path> extends never
    ? [parameters?: { query?: Record<string, unknown> }]
    : [
        parameters: {
          path: PathParameters<Path>;
          query?: Record<string, unknown>;
        },
      ]
): URL {
  return new URL(
    createFinalURL(path, {
      baseUrl: baseUrl.href.replace(/\/$/u, ""),
      params: parameters ?? {},
      querySerializer: createQuerySerializer(),
      pathSerializer: defaultPathSerializer,
    }),
  );
}
