import type { components } from "@linger/wire-contracts/teamhub-internal/types";

type Credential = components["schemas"]["AgentAccessCredential"];

/** The TeamHub endpoint and identity a CLI credential is installed with. */
export interface AgentCliProfile {
  readonly url: string;
  readonly tenantId: string;
  readonly agentId: string;
}

export interface AgentCliIdentity {
  readonly tenantId: string;
  readonly agentId: string;
}

/** The Computer and workspace grant a credential is installed on. */
export interface AgentCliCredentialPlacement {
  readonly computerId: string;
  readonly workspaceGrantId: string;
}

/** Issues the Agent CLI credentials the Runner Gateway installs on Computers. */
export interface AgentCliCredentialIssuer {
  profile(identity: AgentCliIdentity): AgentCliProfile;
  /**
   * Shared by every waiter, so it takes no caller signal. TeamHub refuses a
   * placement the Agent's registration no longer names, so a Computer the
   * Agent moved away from cannot obtain a credential. When `heldSha256` is
   * the token hash of the Agent's live credential for the placement, TeamHub
   * issues nothing and this resolves to "current"; otherwise TeamHub issues a
   * new credential and revokes the Agent's previous Computer credential.
   */
  issue(
    identity: AgentCliIdentity,
    placement: AgentCliCredentialPlacement,
    heldSha256?: string,
  ): Promise<{ readonly accessToken: string } | "current">;
}

/**
 * Issues each credential from TeamHub with the Agent Service token. The CLI
 * reaches TeamHub at `cliBaseUrl`, over HTTP or HTTPS.
 */
export function createTeamHubAgentCliCredentialIssuer(options: {
  readonly baseUrl: string;
  readonly cliBaseUrl?: string;
  readonly serviceToken: string;
  readonly fetch?: typeof globalThis.fetch;
}): AgentCliCredentialIssuer {
  const cliUrl = options.cliBaseUrl ?? options.baseUrl;
  return {
    profile: (identity) => ({
      url: cliUrl,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
    }),
    async issue(identity, placement, heldSha256) {
      const { protocol } = new URL(cliUrl);
      if (protocol !== "https:" && protocol !== "http:") {
        throw new Error("TeamHub CLI requires an HTTP or HTTPS URL");
      }
      const url = new URL(options.baseUrl);
      url.pathname = `${url.pathname.replace(/\/+$/u, "")}/internal/agents/${encodeURIComponent(identity.agentId)}/access-credentials`;
      const body: components["schemas"]["ManagedAgentAccessCredentialRequest"] =
        {
          label: "Managed Agent CLI",
          computer_id: placement.computerId,
          workspace_grant_id: placement.workspaceGrantId,
          ...(heldSha256 === undefined
            ? {}
            : { held_token_sha256: heldSha256 }),
        };
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
          headers: {
            authorization: `Bearer ${options.serviceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        // Fetch exceptions may carry authorization material.
        throw new Error("TeamHub CLI credential preparation failed");
      }
      if (response.status === 204 && heldSha256 !== undefined) return "current";
      if (response.status !== 201) {
        throw new Error(
          `TeamHub CLI credential preparation failed (${response.status})`,
        );
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("TeamHub returned an invalid Agent CLI identity");
      }
      const credential = value as Credential | null;
      if (
        !credential ||
        credential.agent_id !== identity.agentId ||
        credential.tenant_id !== identity.tenantId ||
        typeof credential.credential_id !== "string" ||
        !/^th_agent_[A-Za-z0-9_-]{43}$/u.test(credential.access_token)
      ) {
        throw new Error("TeamHub returned an invalid Agent CLI identity");
      }
      return { accessToken: credential.access_token };
    },
  };
}
