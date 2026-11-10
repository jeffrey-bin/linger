package transport

import (
	"testing"
)

func TestGenerateDerivesStableDaemonIDAndSigns(t *testing.T) {
	identity, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	message := []byte("runner.hello")
	signature, err := identity.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	if !identity.Verify(message, signature) {
		t.Fatal("signature did not verify")
	}
	if identity.DaemonID == "" {
		t.Fatal("daemon id is empty")
	}
	other, err := NewIdentity(identity.PublicKey, identity.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if other.DaemonID != identity.DaemonID {
		t.Fatalf("daemon id changed: %q != %q", other.DaemonID, identity.DaemonID)
	}
}

func TestNewRejectsMismatchedKeyPair(t *testing.T) {
	first, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	second, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewIdentity(first.PublicKey, second.PrivateKey); err == nil {
		t.Fatal("mismatched key pair was accepted")
	}
}
