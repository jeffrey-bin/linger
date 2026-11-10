package agentcredential

import (
	"crypto/sha256"
	"errors"
	"testing"
)

func TestAgentCredentialIsStableOpaqueIdentity(t *testing.T) {
	first, digest, err := newToken()
	if err != nil || !ValidToken(first) || len(digest) != sha256.Size {
		t.Fatalf("invalid credential: valid=%v digest=%d err=%v", ValidToken(first), len(digest), err)
	}
	second, _, err := newToken()
	if err != nil || first == second {
		t.Fatal("credentials must have independent random secrets")
	}
	for _, invalid := range []string{"", "th_agent_", "mcp_ctx_" + first[9:], first + "=", first[:len(first)-1] + "/"} {
		if ValidToken(invalid) {
			t.Fatal("accepted malformed credential")
		}
	}
}

func TestExpectedIdentityConstrainsButNeverGrants(t *testing.T) {
	p := Principal{TenantID: "tenant-a", AgentID: "agent-a"}
	if err := validateExpectedIdentity(WithExpectedIdentity(t.Context(), "tenant-a", "agent-a"), p); err != nil {
		t.Fatal(err)
	}
	if err := validateExpectedIdentity(WithExpectedIdentity(t.Context(), "tenant-a", "agent-b"), p); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross agent expected=%v", err)
	}
	if err := validateExpectedIdentity(WithExpectedIdentity(t.Context(), "tenant-b", "agent-a"), p); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross tenant expected=%v", err)
	}
	if err := validateExpectedIdentity(t.Context(), p); err != nil {
		t.Fatal(err)
	}
}
