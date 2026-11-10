package document

import (
	"strings"
	"testing"
)

func TestAgentMessageAttachmentIdentityScopesIndependentInvocations(t *testing.T) {
	digest := strings.Repeat("a", 64)
	first, err := AgentMessageAttachmentIdentity("actor-agent", "idempotency-a", digest)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := AgentMessageAttachmentIdentity("actor-agent", "idempotency-a", digest)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AgentMessageAttachmentIdentity("actor-agent", "idempotency-b", digest)
	if err != nil {
		t.Fatal(err)
	}
	if first != replay || first.DocumentID == second.DocumentID ||
		first.DocumentVersionID == second.DocumentVersionID {
		t.Fatalf("attachment identities first=%+v replay=%+v second=%+v", first, replay, second)
	}
}
