package agentdirectmessage

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeInputAndInvocationIdentity(t *testing.T) {
	validInvocationID := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	contents, messages, err := normalizeInput(Input{
		InvocationID: validInvocationID,
		Messages:     []string{" first ", "second"},
	})
	if err != nil || len(contents) != 2 || len(messages) != 2 || messages[0] != " first " || messages[1] != "second" {
		t.Fatalf("normalized contents=%+v messages=%v error=%v", contents, messages, err)
	}

	invalid := []Input{
		{InvocationID: validInvocationID},
		{InvocationID: "agent-invocation-sha256:" + strings.Repeat("A", 64), Messages: []string{"message"}},
		{InvocationID: validInvocationID, Messages: []string{"   "}},
		{InvocationID: validInvocationID, Messages: []string{strings.Repeat("x", 50001)}},
		{InvocationID: validInvocationID, Messages: make([]string, 101)},
	}
	for _, input := range invalid {
		if _, _, err := normalizeInput(input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("input=%+v error=%v want ErrInvalid", input, err)
		}
	}
}

func TestRequestHashUsesNormalizedOrderedMessages(t *testing.T) {
	first := hashNormalizedMessages([]string{"one", "two"})
	exact := hashNormalizedMessages([]string{"one", "two"})
	reordered := hashNormalizedMessages([]string{"two", "one"})
	combined := hashNormalizedMessages([]string{"one\x00two"})
	if first != exact {
		t.Fatal("exact normalized messages produced different hashes")
	}
	if first == reordered || first == combined {
		t.Fatal("ordered message boundaries did not affect request hash")
	}
}

func TestSendValidatesInputBeforeDependencies(t *testing.T) {
	service := New(nil, nil)
	validInvocationID := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	if _, err := service.Send(t.Context(), "mcp_ctx_invalid", Input{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid input error=%v want ErrInvalid", err)
	}
	if _, err := service.Send(t.Context(), "mcp_ctx_invalid", Input{
		InvocationID: validInvocationID,
		Messages:     []string{"message"},
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing dependencies error=%v want ErrUnavailable", err)
	}
}
