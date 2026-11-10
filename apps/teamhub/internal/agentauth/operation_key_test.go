package agentauth

import "testing"

func TestIdempotencyKeysAreStableAndUnambiguous(t *testing.T) {
	if got := IdempotencyKey("send_message", "op1"); got != "4f068948f490c48f1dca289d1fe6cc50410ad86ea6f06cb28c62937e85d115a5" {
		t.Errorf("fingerprint changed: %s", got)
	}
	if IdempotencyKey("ab", "c") == IdempotencyKey("a", "bc") {
		t.Fatal("operation and invocation fields collided")
	}
}
