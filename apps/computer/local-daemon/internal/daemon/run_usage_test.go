package daemon

import (
	"encoding/json"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestTerminalRunUsageBuckets(t *testing.T) {
	count := int64(2)
	result := provider.Result{Status: "completed", Output: "done", Usage: map[string]native.TokenCount{"model-b": {Input: 10, CacheRead: 20, Output: 30, Reasoning: 8}, "model-a": {Input: 3, Output: 4}}, LastUsage: map[string]native.TokenCount{"model-b": {Input: 1, CacheRead: 2, Output: 3}}, CompactionCount: &count}
	{
		var payload map[string]any
		spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
		if err := json.Unmarshal(terminalPayload(spec, result), &payload); err != nil {
			t.Fatal(err)
		}
		usage := payload["usage"].([]any)
		if len(usage) != 2 {
			t.Fatalf("usage count=%d", len(usage))
		}
		first, second := usage[0].(map[string]any), usage[1].(map[string]any)
		if first["model"] != "model-a" || first["compaction_count"] != float64(2) || second["compaction_count"] != float64(0) {
			t.Fatalf("compactions duplicated: %v", usage)
		}
		if second["output"] != float64(30) || second["reasoning"] != float64(8) || second["cache_read"] != float64(20) {
			t.Fatalf("buckets=%v", second)
		}
		if second["last"].(map[string]any)["input"] != float64(1) {
			t.Fatal("missing last request")
		}
		result.Status = "failed"
		if err := json.Unmarshal(terminalPayload(spec, result), &payload); err != nil || payload["usage"] == nil {
			t.Fatalf("failed usage lost: %s", terminalPayload(spec, result))
		}
	}
}

func TestReportedRunUsageSkipsUnusableEntries(t *testing.T) {
	count := int64(2)
	spec := provider.OperationSpec{Provider: "claude", OperationKind: "run.start"}
	result := provider.Result{Status: "completed", Usage: map[string]native.TokenCount{
		"<synthetic>": {},
		"model-zero":  {},
		"model-a":     {Input: 3, Output: 4},
		"model-b":     {Output: 2, Reasoning: 3},
	}, LastUsage: map[string]native.TokenCount{"model-b": {Output: 1, Reasoning: 1}}, CompactionCount: &count}
	usage := reportedRunUsage(spec, result)
	if len(usage) != 2 {
		t.Fatalf("usage=%v", usage)
	}
	first, second := usage[0], usage[1]
	if first["model"] != "model-a" || first["compaction_count"] != int64(2) || second["compaction_count"] != int64(0) {
		t.Fatalf("compactions not on first kept model: %v", usage)
	}
	if _, ok := second["reasoning"]; ok {
		t.Fatalf("reasoning above output reported: %v", second)
	}
	if _, ok := second["last"].(map[string]any)["reasoning"]; ok {
		t.Fatalf("last reasoning above output reported: %v", second["last"])
	}
	if reportedRunUsage(spec, provider.Result{Usage: map[string]native.TokenCount{"<synthetic>": {}}}) != nil {
		t.Fatal("unusable-only usage reported")
	}
}

func TestNativeResumeMeasurementOnTerminalOutcomes(t *testing.T) {
	{
		for _, outcome := range []string{"completed", "failed", "aborted"} {
			spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
			result := provider.Result{Status: outcome, NativeResume: &native.NativeResumeMeasurement{DurationMs: 123, Result: "error"}}
			var payload map[string]any
			if err := json.Unmarshal(terminalWithUsage(map[string]any{"reason": "cancel"}, spec, result), &payload); err != nil {
				t.Fatal(err)
			}
			if payload["native_resume"] == nil {
				t.Fatalf("measurement lost: %v", payload)
			}
			if err := json.Unmarshal(terminalPayload(spec, result), &payload); err != nil {
				t.Fatal(err)
			}
			if payload["native_resume"] == nil {
				t.Fatalf("terminal lost: %v", payload)
			}
		}
	}
}
