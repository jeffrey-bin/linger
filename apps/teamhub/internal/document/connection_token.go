package document

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
)

// ConnectionTokenClaims is what a Document connection token asserts. The
// Runtime trusts these claims for the life of one connection and compares
// PermissionCount with the Document's count when it loads the state, so any
// permission change after signing makes the token stale.
type ConnectionTokenClaims struct {
	SessionID       string `json:"session_id"`
	DocumentID      string `json:"document_id"`
	ActorID         string `json:"actor_id"`
	Mode            string `json:"mode"`
	ExpiresAtMillis int64  `json:"expires_at"`
	PermissionCount int64  `json:"permission_count"`
}

// signConnectionToken encodes claims as base64url(JSON) "." base64url(HMAC).
func signConnectionToken(key []byte, claims ConnectionTokenClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + base64.RawURLEncoding.EncodeToString(connectionTokenMAC(key, encoded)), nil
}

func connectionTokenMAC(key []byte, encodedPayload string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(encodedPayload))
	return mac.Sum(nil)
}
