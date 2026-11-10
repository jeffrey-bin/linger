package document

import (
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

func TestCanonicalRequestPath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{name: "file", input: "/assets/app.js", want: "assets/app.js", ok: true},
		{name: "unicode and spaces", input: "/Bilder-Größe/logo 1.png", want: "Bilder-Größe/logo 1.png", ok: true},
		{name: "parent", input: "/../secret.txt"},
		{name: "nested parent", input: "/assets/../secret.txt"},
		{name: "backslash", input: `/assets\..\secret.txt`},
		{name: "encoded residue", input: "/%2e%2e/secret.txt"},
		{name: "double slash", input: "/assets//app.js"},
		{name: "dot", input: "/assets/./app.js"},
		{name: "empty", input: "/"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := canonicalRequestPath(test.input)
			if test.ok {
				if err != nil || got != test.want {
					t.Fatalf("canonicalRequestPath(%q)=(%q,%v) want (%q,nil)", test.input, got, err, test.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("canonicalRequestPath(%q)=%q want error", test.input, got)
			}
		})
	}
}

func TestPreviewTokenExpiresAndNeedsIdentity(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	service := &PreviewService{key: []byte("preview-test-key"), now: func() time.Time { return now }}
	sign := func(token previewToken) string {
		value, err := secretbox.Sign(service.key, previewTokenDomain, token)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	token := sign(previewToken{AccountID: "account_alice", VersionID: "version_1", ExpiresAt: now.Add(PreviewLinkTTL).Unix()})
	if signed, ok := service.verifyToken(token); !ok || signed.AccountID != "account_alice" || signed.VersionID != "version_1" {
		t.Fatalf("verifyToken(signed)=(%+v,%t)", signed, ok)
	}
	if _, ok := service.verifyToken(sign(previewToken{ExpiresAt: now.Add(PreviewLinkTTL).Unix()})); ok {
		t.Error("token without account and Version verified")
	}
	other := &PreviewService{key: []byte("other-key"), now: service.now}
	if _, ok := other.verifyToken(token); ok {
		t.Error("token verified under another key")
	}
	now = now.Add(PreviewLinkTTL)
	if _, ok := service.verifyToken(token); ok {
		t.Error("expired token verified")
	}
}
