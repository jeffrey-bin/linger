import { describe, expect, it } from "vitest";

import { verifyConnectionToken } from "../../src/document/connection-token.js";

// Signed by TeamHub's signConnectionToken; pinned by
// apps/teamhub/internal/document/connection_token_test.go. Both must change
// together.
const vectorKey = "document-connection-token-test-key";
const vectorToken =
  "eyJzZXNzaW9uX2lkIjoiZG9jdW1lbnRfc2Vzc2lvbl92ZWN0b3IiLCJkb2N1bWVudF9pZCI6ImRvY3VtZW50X3ZlY3RvciIsImFjdG9yX2lkIjoiYWN0b3JfdmVjdG9yIiwibW9kZSI6IndyaXRlIiwiZXhwaXJlc19hdCI6NDEwMjQ0NDgwMDAwMCwicGVybWlzc2lvbl9jb3VudCI6N30.bWzP4gLTKXLX-KgEMbPeDX_gL_shSBYlN01DUvdBF5Y";

describe("Document connection token", () => {
  it("verifies the token TeamHub signs", () => {
    expect(verifyConnectionToken(vectorKey, vectorToken, 0)).toEqual({
      sessionId: "document_session_vector",
      documentId: "document_vector",
      actorId: "actor_vector",
      mode: "write",
      expiresAt: 4102444800000,
      permissionCount: 7,
    });
  });

  it("refuses another key, a changed claim and an expired token", () => {
    expect(() => verifyConnectionToken("another key", vectorToken, 0)).toThrow(
      "Document authentication is invalid",
    );
    const [payload, signature] = vectorToken.split(".") as [string, string];
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const raised = Buffer.from(
      JSON.stringify({ ...claims, permission_count: 8 }),
    ).toString("base64url");
    expect(() =>
      verifyConnectionToken(vectorKey, `${raised}.${signature}`, 0),
    ).toThrow("Document authentication is invalid");
    expect(() =>
      verifyConnectionToken(vectorKey, vectorToken, 4102444800000),
    ).toThrow("Document connection token has expired");
  });
});
