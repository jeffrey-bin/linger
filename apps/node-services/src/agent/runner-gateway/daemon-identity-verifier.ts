import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";

import { RunnerGatewayProtocolError } from "./runner-operation.js";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_PROOF_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_RETAINED_NONCES = 4_096;

export class ComputerDaemonIdentityStaleError extends RunnerGatewayProtocolError {
  constructor(
    readonly reason: "unparseable" | "past" | "future",
    readonly sentAt: string,
    readonly serverTimeMs: number,
    readonly differenceMs: number | null,
    readonly proofMaxAgeMs: number,
  ) {
    super("Computer Daemon Identity proof is stale");
    this.name = "ComputerDaemonIdentityStaleError";
  }
}

/**
 * Checks that a hello was signed by the Daemon key it names, recently and
 * once. TeamHub binds the Computer to that key when the hello is recorded.
 */
export interface ComputerDaemonIdentityVerifier {
  verify(input: {
    readonly computerId: string;
    readonly hello: RunnerHello;
  }): void;
}

export const createComputerDaemonIdentityVerifier = (
  options: {
    readonly now?: () => number;
    readonly proofMaxAgeMs?: number;
  } = {},
): ComputerDaemonIdentityVerifier => {
  const now = options.now ?? Date.now;
  const proofMaxAgeMs = options.proofMaxAgeMs ?? DEFAULT_PROOF_MAX_AGE_MS;
  if (!Number.isSafeInteger(proofMaxAgeMs) || proofMaxAgeMs <= 0) {
    throw new TypeError("Computer Daemon Identity proof age must be positive");
  }
  const acceptedNonces = new Map<string, number>();
  return {
    verify({ computerId, hello }) {
      const identity = hello.daemon_identity;
      if (!identity) {
        throw invalidIdentity("Computer Daemon Identity proof is missing");
      }
      const publicKey = decodeExactBase64(
        identity.public_key,
        ED25519_PUBLIC_KEY_BYTES,
      );
      const proof = decodeExactBase64(identity.proof, ED25519_SIGNATURE_BYTES);
      const derivedDaemonId = createHash("sha256")
        .update(publicKey)
        .digest("base64url");
      if (derivedDaemonId !== identity.daemon_id) {
        throw invalidIdentity(
          "Computer Daemon Identity does not match its public key",
        );
      }
      const sentAt = Date.parse(hello.sent_at);
      const serverTimeMs = now();
      const differenceMs = Number.isFinite(sentAt)
        ? serverTimeMs - sentAt
        : null;
      if (differenceMs === null || Math.abs(differenceMs) > proofMaxAgeMs) {
        throw new ComputerDaemonIdentityStaleError(
          differenceMs === null
            ? "unparseable"
            : differenceMs > 0
              ? "past"
              : "future",
          hello.sent_at,
          serverTimeMs,
          differenceMs,
          proofMaxAgeMs,
        );
      }
      const nonceKey = `${computerId}\0${hello.connection_nonce}`;
      if (acceptedNonces.has(nonceKey)) {
        throw invalidIdentity("Computer Daemon Identity proof was replayed");
      }
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
        format: "der",
        type: "spki",
      });
      if (
        !verifySignature(
          null,
          computerDaemonIdentityProofPayload(hello),
          key,
          proof,
        )
      ) {
        throw invalidIdentity("Computer Daemon Identity proof is invalid");
      }
      acceptedNonces.set(nonceKey, sentAt);
      pruneAcceptedNonces(acceptedNonces, now() - proofMaxAgeMs);
    },
  };
};

export const computerDaemonIdentityProofPayload = (
  hello: Pick<
    RunnerHello,
    "runner_id" | "connection_nonce" | "sent_at" | "protocol_version"
  >,
): Buffer =>
  Buffer.from(
    [
      "simplex-computer-daemon-identity-v1",
      hello.runner_id,
      hello.connection_nonce,
      hello.sent_at,
      hello.protocol_version,
    ].join("\0"),
    "utf8",
  );

const decodeExactBase64 = (value: string, bytes: number): Buffer => {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) {
    throw invalidIdentity("Computer Daemon Identity contains invalid base64");
  }
  return decoded;
};

const pruneAcceptedNonces = (
  nonces: Map<string, number>,
  oldestAcceptedAt: number,
): void => {
  for (const [key, acceptedAt] of nonces) {
    if (acceptedAt >= oldestAcceptedAt && nonces.size <= MAX_RETAINED_NONCES) {
      break;
    }
    nonces.delete(key);
  }
};

const invalidIdentity = (message: string): RunnerGatewayProtocolError =>
  new RunnerGatewayProtocolError(message);
