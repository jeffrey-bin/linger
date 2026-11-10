package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestValidAgentMemoryPendingSource(t *testing.T) {
	source := `"source_key":"` + strings.Repeat("a", 64) + `","thread_id":"thread","through":3`
	cases := []struct {
		name    string
		pending string
		valid   bool
	}{
		{"extract names its source", `{"stage":"extract","prompt":"p",` + source + `}`, true},
		{"extract without a source", `{"stage":"extract","prompt":"p"}`, false},
		{"consolidate has no source", `{"stage":"consolidate","prompt":"p"}`, true},
		{"consolidate with a source", `{"stage":"consolidate","prompt":"p",` + source + `}`, false},
	}
	for _, tc := range cases {
		var document teamhubinternal.AgentMemoryDocument
		raw := `{"revision":0,"summary":"","memory":"","sessions":{},"cursors":{},"pending":` + tc.pending + `}`
		if err := json.Unmarshal([]byte(raw), &document); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := validAgentMemory(document); got != tc.valid {
			t.Errorf("%s: valid = %v, want %v", tc.name, got, tc.valid)
		}
	}
}
