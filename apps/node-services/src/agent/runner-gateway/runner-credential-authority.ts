import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  LocalComputerOwner,
  LocalComputerRegistry,
} from "./local-computer-registry.js";
import { isRecord } from "@linger/service-kit";

export interface RunnerGatewayCredential {
  readonly expiresAtMs?: number;
  readonly runnerId: string;
  readonly token: string;
  readonly credentialGeneration: number;
  readonly tenantOwners: readonly {
    readonly tenantId: string;
    readonly ownerActorId: string;
  }[];
}

export interface RunnerCredentialAuthenticator {
  authenticate(
    authorizationHeader: string | undefined,
  ): RunnerGatewayCredential | null | Promise<RunnerGatewayCredential | null>;
}

interface RunnerTokenClaims {
  readonly credential_generation: number;
  readonly exp: number;
  readonly iat: number;
  readonly runner_id: string;
  readonly tenant_owners: readonly {
    readonly owner_actor_id: string;
    readonly tenant_id: string;
  }[];
  readonly v: 1;
}

const TOKEN_PREFIX = "sr1";
const MAX_TOKEN_BYTES = 4_096;
const CLOCK_SKEW_SECONDS = 60;

/**
 * Verifies the Runner Gateway credentials TeamHub signs at enrollment. A
 * signed token is active while its generation is the Computer's current one
 * and it names the Computer's owner; TeamHub's Computer row decides both, so
 * a renewal or removal refuses the earlier credential at its next connection.
 */
export class TeamHubRunnerCredentialAuthority implements RunnerCredentialAuthenticator {
  readonly #now: () => number;
  readonly #signingKey: Buffer;
  readonly #registry: Pick<LocalComputerRegistry, "credentialGeneration">;

  constructor(options: {
    readonly now?: () => number;
    readonly signingKey: string;
    readonly registry: Pick<LocalComputerRegistry, "credentialGeneration">;
  }) {
    this.#now = options.now ?? Date.now;
    this.#signingKey = Buffer.from(options.signingKey, "utf8");
    this.#registry = options.registry;
    if (
      this.#signingKey.byteLength < 32 ||
      this.#signingKey.byteLength > 1024
    ) {
      throw new TypeError(
        "Runner credential signing key must be 32-1024 bytes",
      );
    }
  }

  async authenticate(
    authorizationHeader: string | undefined,
  ): Promise<RunnerGatewayCredential | null> {
    const parsed = parseRunnerCredential(
      authorizationHeader,
      this.#signingKey,
      this.#now(),
    );
    // A Computer has one owner.
    const owner =
      parsed?.tenantOwners.length === 1 ? parsed.tenantOwners[0] : undefined;
    if (!parsed || !owner) return null;
    const { credential_generation: generation, runner_id: computerId } =
      parsed.claims;
    return (await this.#registry.credentialGeneration(computerId, owner)) ===
      generation
      ? {
          runnerId: computerId,
          tenantOwners: parsed.tenantOwners,
          credentialGeneration: generation,
          expiresAtMs: parsed.claims.exp * 1_000,
          token: parsed.token,
        }
      : null;
  }
}

const parseRunnerCredential = (
  authorizationHeader: string | undefined,
  signingKey: Buffer,
  now: number,
): {
  readonly claims: RunnerTokenClaims;
  readonly tenantOwners: readonly LocalComputerOwner[];
  readonly token: string;
} | null => {
  const token = readBearerToken(authorizationHeader);
  if (!token || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const encodedPayload = parts[1] as string;
  const signature = decodeBase64Url(parts[2] as string);
  if (!signature) return null;
  const expected = createHmac("sha256", signingKey)
    .update(`${TOKEN_PREFIX}.${encodedPayload}`)
    .digest();
  if (
    signature.byteLength !== expected.byteLength ||
    !timingSafeEqual(signature, expected)
  ) {
    return null;
  }
  const claims = parseClaims(encodedPayload, now);
  if (!claims) return null;
  return {
    claims,
    tenantOwners: claims.tenant_owners.map((owner) => ({
      ownerActorId: owner.owner_actor_id,
      tenantId: owner.tenant_id,
    })),
    token,
  };
};

const parseClaims = (
  encodedPayload: string,
  nowMs: number,
): RunnerTokenClaims | null => {
  const decoded = decodeBase64Url(encodedPayload);
  if (!decoded) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "credential_generation",
      "exp",
      "iat",
      "runner_id",
      "tenant_owners",
      "v",
    ])
  ) {
    return null;
  }
  const owners = value.tenant_owners;
  const now = Math.floor(nowMs / 1_000);
  if (
    value.v !== 1 ||
    !Number.isSafeInteger(value.credential_generation) ||
    (value.credential_generation as number) < 0 ||
    !isId(value.runner_id) ||
    !Number.isSafeInteger(value.iat) ||
    !Number.isSafeInteger(value.exp) ||
    (value.iat as number) > now + CLOCK_SKEW_SECONDS ||
    (value.exp as number) <= (value.iat as number) ||
    !Array.isArray(owners) ||
    owners.length === 0
  ) {
    return null;
  }
  const tenantIds = new Set<string>();
  for (const owner of owners) {
    if (
      !isRecord(owner) ||
      !hasExactKeys(owner, ["owner_actor_id", "tenant_id"]) ||
      !isId(owner.owner_actor_id) ||
      !isId(owner.tenant_id) ||
      tenantIds.has(owner.tenant_id)
    ) {
      return null;
    }
    tenantIds.add(owner.tenant_id);
  }
  return value as unknown as RunnerTokenClaims;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

const readBearerToken = (header: string | undefined): string | null => {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
};

const decodeBase64Url = (value: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
};

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};
