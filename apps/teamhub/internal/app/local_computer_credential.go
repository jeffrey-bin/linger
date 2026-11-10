package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"time"
)

// runnerCredentialLifetime matches how long an enrolled Computer keeps its
// Runner Gateway credential; renewal or removal revokes it sooner through the
// credential generation that Agent Service checks on every connection.
const runnerCredentialLifetime = 10 * 365 * 24 * time.Hour

// localComputerEnrollmentLifetime bounds the one-time PKCE authorization.
const localComputerEnrollmentLifetime = 5 * time.Minute

type runnerCredentialOwner struct {
	OwnerActorID string `json:"owner_actor_id"`
	TenantID     string `json:"tenant_id"`
}

// runnerCredentialClaims is the exact claim set Agent Service's Runner
// Gateway verifies; it rejects a token with any other key.
type runnerCredentialClaims struct {
	CredentialGeneration int64                   `json:"credential_generation"`
	Exp                  int64                   `json:"exp"`
	Iat                  int64                   `json:"iat"`
	RunnerID             string                  `json:"runner_id"`
	TenantOwners         []runnerCredentialOwner `json:"tenant_owners"`
	V                    int                     `json:"v"`
}

// signRunnerCredential issues an `sr1` Runner Gateway token: the base64url
// claims and an HMAC-SHA256 over "sr1.<claims>" keyed by the `runner-signing`
// service credential string.
func signRunnerCredential(signingKey string, claims runnerCredentialClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := "sr1." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(signingKey))
	mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
