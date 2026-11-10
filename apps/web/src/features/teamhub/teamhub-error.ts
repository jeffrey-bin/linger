import type { TeamHubErrorResponse } from "./teamhub-types";

export class TeamHubError extends Error {
  readonly code: string;
  readonly details?: TeamHubErrorResponse["error"]["details"];
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;
  readonly status: number;

  constructor(input: {
    code: string;
    details?: TeamHubErrorResponse["error"]["details"];
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
    retryable?: boolean;
    status: number;
  }) {
    super(input.message);
    this.name = "TeamHubError";
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
  }
}

export class TeamHubTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamHubTransportError";
  }
}

export async function readTeamHubError(response: Response) {
  let body: TeamHubErrorResponse | undefined;

  try {
    body = (await response.clone().json()) as TeamHubErrorResponse;
  } catch {
    body = undefined;
  }

  return new TeamHubError({
    code: body?.error?.code ?? `HTTP_${response.status}`,
    details: body?.error?.details,
    message: body?.error?.message ?? fallbackErrorMessage(response.status),
    requestId: body?.error?.request_id,
    retryAfterSeconds: parseRetryAfterSeconds(
      response.headers.get("Retry-After"),
    ),
    retryable: body?.error?.retryable,
    status: response.status,
  });
}

// A response without a TeamHub error body came from a layer in front of
// TeamHub (gateway, proxy, WAF), so only the status class is meaningful.
function fallbackErrorMessage(status: number) {
  if (status === 401 || status === 403) {
    return "The server refused this request. Reload the page and try again.";
  }
  if (status === 429) {
    return "Too many requests. Wait a moment and try again.";
  }
  if (status >= 500) {
    return "The server is temporarily unavailable. Try again shortly.";
  }
  return `The server could not complete this request (${status}). Try again.`;
}

function parseRetryAfterSeconds(value: string | null) {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}
