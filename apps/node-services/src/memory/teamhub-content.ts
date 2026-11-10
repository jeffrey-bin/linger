import { teamHubBaseUrl } from "../teamhub-base-url.js";
import { teamHubFetch } from "./teamhub-transport.js";
import {
  fetchTeamHubSession,
  type TeamHubAgentCallbackFetch,
} from "@linger/wire-contracts/teamhub-internal/client";
import { serviceCredential } from "@linger/service-kit/node";

export interface TeamHubContentAccess {
  baseUrl: string;
  fetch?: TeamHubAgentCallbackFetch;
  token: string;
}

export function teamHubContentAccess(
  environment: NodeJS.ProcessEnv = process.env,
): TeamHubContentAccess {
  const baseUrl = teamHubBaseUrl(environment);
  const token = memoryTeamHubToken(environment);
  if (!token) throw new Error("LINGER_SECRET_SEED is required");
  return { baseUrl, token };
}

export async function fetchTeamHubDocumentVersionContent(
  access: TeamHubContentAccess,
  tenantId: string,
  documentVersionId: string,
  maxBytes = 1_000_000,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchTeamHubSession({
      baseUrl: access.baseUrl,
      documentVersionId,
      fetch: teamHubFetch(access.fetch),
      serviceToken: access.token,
      signal: AbortSignal.timeout(120_000),
      tenantId,
    });
  } catch (error) {
    throw new Error("TeamHub content read was interrupted", { cause: error });
  }
  if (!response.ok) {
    throw new Error(`TeamHub content read failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("TeamHub content response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new Error("TeamHub content exceeds the supported byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

/** Memory→TeamHub credential, derived from the secret seed. */
export function memoryTeamHubToken(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return serviceCredential("teamhub-internal", environment);
}
