import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { vi } from "vitest";

import {
  TeamHubRunnerCredentialAuthority,
  type RunnerCredentialAuthenticator,
  type RunnerGatewayCredential,
} from "../../../src/agent/runner-gateway/runner-credential-authority.js";
import { hasBearerToken } from "../../../src/agent/service-bearer-auth.js";

export const TEST_RUNNER_SIGNING_KEY =
  "runner-signing-key-that-is-at-least-32-bytes";

export interface TestRunnerCredential {
  readonly computerId: string;
  readonly gatewayToken: string;
  readonly generation: number;
  readonly owner: { readonly tenantId: string; readonly ownerActorId: string };
}

/**
 * Signs a Runner credential the way TeamHub's enrollment exchange does; the
 * shared token vector in runner-credential-authority.test.ts keeps the two
 * signers equal.
 */
export function signTestRunnerCredential(options: {
  readonly computerId: string;
  readonly generation?: number;
  readonly tenantId?: string;
  readonly ownerActorId?: string;
  readonly issuedAtMs?: number;
  readonly lifetimeMs?: number;
  readonly signingKey?: string;
}): TestRunnerCredential {
  const issuedAt = Math.floor((options.issuedAtMs ?? Date.now()) / 1_000);
  const owner = {
    tenantId: options.tenantId ?? "tenant-acme",
    ownerActorId: options.ownerActorId ?? "actor-alice",
  };
  const generation = options.generation ?? 0;
  const payload = Buffer.from(
    JSON.stringify({
      credential_generation: generation,
      exp: issuedAt + Math.floor((options.lifetimeMs ?? 60_000) / 1_000),
      iat: issuedAt,
      runner_id: options.computerId,
      tenant_owners: [
        { owner_actor_id: owner.ownerActorId, tenant_id: owner.tenantId },
      ],
      v: 1,
    }),
  ).toString("base64url");
  const unsigned = `sr1.${payload}`;
  const signature = createHmac(
    "sha256",
    Buffer.from(options.signingKey ?? TEST_RUNNER_SIGNING_KEY, "utf8"),
  )
    .update(unsigned)
    .digest("base64url");
  return {
    computerId: options.computerId,
    gatewayToken: `${unsigned}.${signature}`,
    generation,
    owner,
  };
}

// Exercises the production verifier against Computer rows the test drives:
// `enroll` plays TeamHub committing a credential generation.
export const createRunnerCredentialTestFixture = (
  options: { readonly now?: () => number } = {},
) => {
  const committed = new Map<string, TestRunnerCredential>();
  const credentialGeneration = vi.fn(
    async (
      computerId: string,
      owner: { readonly tenantId: string; readonly ownerActorId: string },
    ) => {
      const current = committed.get(computerId);
      return current && isDeepStrictEqual(owner, current.owner)
        ? current.generation
        : null;
    },
  );
  const authority = new TeamHubRunnerCredentialAuthority({
    registry: { credentialGeneration },
    signingKey: TEST_RUNNER_SIGNING_KEY,
    ...options,
  });
  const enroll = (
    computerId = `computer_${committed.size + 1}`,
    generation = (committed.get(computerId)?.generation ?? -1) + 1,
  ): TestRunnerCredential => {
    const credential = signTestRunnerCredential({
      computerId,
      generation,
      ...(options.now ? { issuedAtMs: options.now() } : {}),
    });
    committed.set(computerId, credential);
    return credential;
  };
  return { authority, enroll, credentialGeneration };
};

// Accepts exactly these bearer tokens as already issued credentials, so a
// Gateway test can connect a Runner without going through enrollment.
export const createTestRunnerCredentialAuthority = (
  credentials: readonly RunnerGatewayCredential[],
): RunnerCredentialAuthenticator => ({
  authenticate: (header) =>
    credentials.find((credential) =>
      hasBearerToken(header, credential.token),
    ) ?? null,
});
