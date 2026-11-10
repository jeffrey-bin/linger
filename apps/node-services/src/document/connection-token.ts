import { createHmac, timingSafeEqual } from "node:crypto";

import { RuntimeConnectionError } from "./realtime-session.js";

/** What a Document connection token asserts, as TeamHub signed it. */
export interface ConnectionTokenClaims {
  actorId: string;
  documentId: string;
  expiresAt: number;
  mode: "read" | "write";
  permissionCount: number;
  sessionId: string;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Verifies a token TeamHub signed as base64url(JSON) "." base64url(HMAC-SHA256)
 * with the key both derive from LINGER_SECRET_SEED, and returns its claims.
 * A bad signature, malformed claims or a past expiry refuses the connection.
 */
export function verifyConnectionToken(
  key: string,
  token: string,
  now = Date.now(),
): ConnectionTokenClaims {
  const separator = token.indexOf(".");
  if (separator < 1 || separator !== token.lastIndexOf(".")) {
    throw invalidToken();
  }
  const encodedPayload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = createHmac("sha256", key).update(encodedPayload).digest();
  if (
    signature.byteLength !== expected.byteLength ||
    !timingSafeEqual(signature, expected)
  ) {
    throw invalidToken();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    throw invalidToken();
  }
  const claims = parseClaims(payload);
  if (claims.expiresAt <= now) {
    throw new RuntimeConnectionError("Document connection token has expired");
  }
  return claims;
}

function parseClaims(payload: unknown): ConnectionTokenClaims {
  if (payload === null || typeof payload !== "object") {
    throw invalidToken();
  }
  const value = payload as Record<string, unknown>;
  const {
    actor_id: actorId,
    document_id: documentId,
    expires_at: expiresAt,
    mode,
    permission_count: permissionCount,
    session_id: sessionId,
  } = value;
  if (
    !validIdentifier(actorId) ||
    !validIdentifier(documentId) ||
    !validIdentifier(sessionId) ||
    (mode !== "read" && mode !== "write") ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(permissionCount) ||
    (permissionCount as number) < 0
  ) {
    throw invalidToken();
  }
  return {
    actorId,
    documentId,
    expiresAt: expiresAt as number,
    mode,
    permissionCount: permissionCount as number,
    sessionId,
  };
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    identifierPattern.test(value)
  );
}

function invalidToken(): RuntimeConnectionError {
  return new RuntimeConnectionError("Document authentication is invalid");
}
