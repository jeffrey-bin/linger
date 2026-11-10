package agentruntimestate

import (
	"errors"
	"testing"
)

func TestMetaContextCursorRoundTripAndValidation(t *testing.T) {
	const agentManagementID = "agent-reviewer"
	cursor := encodeMetaContextCursor(agentManagementID)
	decoded, err := decodeMetaContextCursor(cursor)
	if err != nil || decoded != agentManagementID {
		t.Fatalf("decode meta Context cursor=%q value=%q err=%v", cursor, decoded, err)
	}
	for _, invalid := range []string{"invalid!", "_w"} {
		if _, err := decodeMetaContextCursor(invalid); !errors.Is(err, ErrInvalid) {
			t.Fatalf("decode invalid meta Context cursor %q error=%v", invalid, err)
		}
	}
}
