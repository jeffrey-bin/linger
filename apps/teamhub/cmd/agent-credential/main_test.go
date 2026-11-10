package main

import (
	"bytes"
	"testing"
)

func TestRunRejectsIncompleteCommandsBeforeConnecting(t *testing.T) {
	for _, args := range [][]string{nil, {"rotate"}, {"revoke"}, {"revoke", "--agent-id", ""}, {"revoke", "--agent-id", "agent", "extra"}} {
		var stdout bytes.Buffer
		if err := run(t.Context(), args, &stdout); err == nil || err.Error() != usage {
			t.Fatalf("run(%q) = %v, want usage", args, err)
		}
	}
}
