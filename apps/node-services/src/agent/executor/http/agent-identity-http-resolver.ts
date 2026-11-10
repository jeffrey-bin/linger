import type {
  AgentIdentityResolver,
  AgentRepresentedHuman,
  AgentType,
  ResolvedAgentIdentity,
  AgentId,
} from "../types.js";
import {
  AgentIdentityResolutionError,
  type AgentIdentityResolutionErrorKind,
} from "../agent-manager-api.js";
import {
  createTeamHubAgentIdentityUrl,
  getTeamHubAgentIdentity,
  type TeamHubAgentCallbackFetch,
} from "@linger/wire-contracts/teamhub-internal/client";
import { isRecord } from "@linger/service-kit";

export interface AgentIdentityHttpResolverOptions {
  baseUrl: string;
  serviceToken: string;
  requestTimeoutMs?: number;
  fetch?: TeamHubAgentCallbackFetch;
}

export class AgentIdentityHttpError extends AgentIdentityResolutionError {
  constructor(
    kind: AgentIdentityResolutionErrorKind,
    readonly status: number | null,
    readonly identityUrl: string,
    message: string,
    readonly responseBody: string | null = null,
  ) {
    super(kind, message);
    this.name = "AgentIdentityHttpError";
  }
}

export const createAgentIdentityHttpResolver = (
  options: AgentIdentityHttpResolverOptions,
): AgentIdentityResolver => {
  const baseUrl = options.baseUrl;
  const serviceToken = requireNonEmpty(options.serviceToken, "serviceToken");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive safe integer");
  }
  const fetchRequest = options.fetch ?? globalThis.fetch;

  return {
    async resolveIdentity(agentId: AgentId): Promise<ResolvedAgentIdentity> {
      const identityUrl = createTeamHubAgentIdentityUrl(baseUrl, agentId);
      let response: Response;
      try {
        response = await getTeamHubAgentIdentity({
          baseUrl,
          agentId,
          fetch: fetchRequest,
          serviceToken,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new AgentIdentityHttpError(
          "transient",
          null,
          identityUrl,
          `Agent identity callback failed: ${errorMessage(error)}`,
        );
      }
      if (!response.ok) {
        const responseBody = await readErrorBody(response);
        const detail = responseBody ? `: ${responseBody}` : "";
        throw new AgentIdentityHttpError(
          classifyHttpFailure(response.status),
          response.status,
          identityUrl,
          `Agent identity callback returned HTTP ${response.status}${detail}`,
          responseBody,
        );
      }
      const identity = parseAgentIdentity(
        await readJson(response, identityUrl),
        {
          agentId,
          identityUrl,
          status: response.status,
        },
      );
      return identity;
    },
  };
};

const parseAgentIdentity = (
  value: unknown,
  context: { agentId: AgentId; identityUrl: string; status: number },
): ResolvedAgentIdentity => {
  if (!isRecord(value) || !isRecord(value.actor) || !isRecord(value.sponsor)) {
    throw invalidResponse(context, "body, actor, and sponsor must be objects");
  }
  if (value.agent_id !== context.agentId) {
    throw invalidResponse(
      context,
      "response agent_id must match the requested Agent ID",
    );
  }
  if (value.actor.kind !== "agent") {
    throw invalidResponse(context, 'actor.kind must be "agent"');
  }
  const actorId = readNonEmptyString(value.actor.id);
  if (!actorId) {
    throw invalidResponse(context, "actor.id must be a non-empty string");
  }
  if (!readNonEmptyString(value.actor.display_name)) {
    throw invalidResponse(
      context,
      "actor.display_name must be a non-empty string",
    );
  }
  const agentType = readAgentType(value.agent_type);
  if (!agentType) {
    throw invalidResponse(
      context,
      'agent_type must be "general" or "anotherme"',
    );
  }
  const sponsorActorId = readNonEmptyString(value.sponsor.id);
  if (!sponsorActorId) {
    throw invalidResponse(context, "sponsor.id must be a non-empty string");
  }
  if (sponsorActorId === actorId) {
    throw invalidResponse(context, "sponsor.id must differ from actor.id");
  }
  const sponsorDisplayName = readNonEmptyString(value.sponsor.display_name);
  if (!sponsorDisplayName) {
    throw invalidResponse(
      context,
      "sponsor.display_name must be a non-empty string",
    );
  }
  const representedHuman = readRepresentedHuman(value.represented_human, {
    actorId,
    agentType,
    context,
  });
  return Object.freeze({
    actorId,
    agentType,
    sponsor: Object.freeze({
      actorId: sponsorActorId,
      displayName: sponsorDisplayName,
    }),
    ...(representedHuman ? { representedHuman } : {}),
  });
};

const readRepresentedHuman = (
  value: unknown,
  input: {
    actorId: string;
    agentType: AgentType;
    context: { identityUrl: string; status: number };
  },
): AgentRepresentedHuman | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (input.agentType !== "anotherme") {
    throw invalidResponse(
      input.context,
      "represented_human is allowed only for anotherme",
    );
  }
  if (!isRecord(value)) {
    throw invalidResponse(input.context, "represented_human must be an object");
  }
  const actorId = readNonEmptyString(value.id);
  if (!actorId || actorId === input.actorId) {
    throw invalidResponse(
      input.context,
      "represented_human.id must be non-empty and differ from actor.id",
    );
  }
  const displayName = readNonEmptyString(value.display_name);
  if (!displayName) {
    throw invalidResponse(
      input.context,
      "represented_human.display_name must be a non-empty string",
    );
  }
  let memory: AgentRepresentedHuman["memory"];
  if (value.memory !== undefined) {
    const version = isRecord(value.memory) ? value.memory.version : undefined;
    const markdown = isRecord(value.memory) ? value.memory.markdown : undefined;
    if (
      !Number.isSafeInteger(version) ||
      Number(version) < 1 ||
      typeof markdown !== "string" ||
      !markdown ||
      Buffer.byteLength(markdown, "utf8") > 16_384
    )
      throw invalidResponse(
        input.context,
        "represented_human.memory must contain a positive version and bounded markdown",
      );
    memory = Object.freeze({ version: Number(version), markdown });
  }
  return Object.freeze({
    actorId: actorId,
    displayName,
    ...(memory ? { memory } : {}),
  });
};

const invalidResponse = (
  context: { identityUrl: string; status: number },
  detail: string,
): AgentIdentityHttpError =>
  new AgentIdentityHttpError(
    "permanent",
    context.status,
    context.identityUrl,
    `Invalid Agent identity response: ${detail}`,
  );

const readJson = async (
  response: Response,
  identityUrl: string,
): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new AgentIdentityHttpError(
      "permanent",
      response.status,
      identityUrl,
      `Invalid Agent identity response: ${errorMessage(error)}`,
    );
  }
};

const readErrorBody = async (response: Response): Promise<string | null> => {
  try {
    const body = (await response.text()).trim();
    if (!body) {
      return null;
    }
    const maximumLength = 4_096;
    return body.length <= maximumLength
      ? body
      : `${body.slice(0, maximumLength)}...`;
  } catch {
    return null;
  }
};

const classifyHttpFailure = (
  status: number,
): AgentIdentityResolutionErrorKind => {
  if (status === 404) {
    return "not_found";
  }
  return status >= 500 && status <= 599 ? "transient" : "permanent";
};

const requireNonEmpty = (value: string, name: string): string => {
  if (!value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
};

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const readAgentType = (value: unknown): AgentType | null =>
  value === "general" || value === "anotherme" ? value : null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
