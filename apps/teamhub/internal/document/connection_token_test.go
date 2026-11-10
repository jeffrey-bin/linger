package document

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// connectionTokenVector is pinned by the Document Runtime's verifier test in
// apps/node-services/tests/document/connection-token.test.ts; both must change
// together.
const (
	connectionTokenVectorKey   = "document-connection-token-test-key"
	connectionTokenVectorToken = "eyJzZXNzaW9uX2lkIjoiZG9jdW1lbnRfc2Vzc2lvbl92ZWN0b3IiLCJkb2N1bWVudF9pZCI6ImRvY3VtZW50X3ZlY3RvciIsImFjdG9yX2lkIjoiYWN0b3JfdmVjdG9yIiwibW9kZSI6IndyaXRlIiwiZXhwaXJlc19hdCI6NDEwMjQ0NDgwMDAwMCwicGVybWlzc2lvbl9jb3VudCI6N30.bWzP4gLTKXLX-KgEMbPeDX_gL_shSBYlN01DUvdBF5Y"
)

var connectionTokenVectorClaims = ConnectionTokenClaims{
	SessionID: "document_session_vector", DocumentID: "document_vector", ActorID: "actor_vector",
	Mode: "write", ExpiresAtMillis: 4102444800000, PermissionCount: 7,
}

func TestConnectionTokenMatchesRuntimeVector(t *testing.T) {
	token, err := signConnectionToken([]byte(connectionTokenVectorKey), connectionTokenVectorClaims)
	if err != nil {
		t.Fatal(err)
	}
	if token != connectionTokenVectorToken {
		t.Fatalf("token=%q want=%q", token, connectionTokenVectorToken)
	}
}

func TestConnectionTokenSignatureCoversEveryClaim(t *testing.T) {
	key := []byte(connectionTokenVectorKey)
	token, err := signConnectionToken(key, connectionTokenVectorClaims)
	if err != nil {
		t.Fatal(err)
	}
	encoded, signature, _ := strings.Cut(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var claims ConnectionTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims != connectionTokenVectorClaims {
		t.Fatalf("claims=%+v err=%v", claims, err)
	}
	stale := connectionTokenVectorClaims
	stale.PermissionCount = 6
	staleToken, err := signConnectionToken(key, stale)
	if err != nil {
		t.Fatal(err)
	}
	_, staleSignature, _ := strings.Cut(staleToken, ".")
	if staleSignature == signature {
		t.Fatal("a token under another permission count has the same signature")
	}
	got, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(got, connectionTokenMAC(key, encoded)) {
		t.Fatal("signature does not verify against its payload")
	}
	if hmac.Equal(got, connectionTokenMAC([]byte("another key"), encoded)) {
		t.Fatal("signature verifies under another key")
	}
}
