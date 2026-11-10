package permission

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

func TestApprovedSkillScriptRunsOnceWithTheReviewedBodyAndArgs(t *testing.T) {
	now := time.Now()
	path := "/skills/site/scripts/read.js"
	scope := ScriptScope("agent-1", "context-1")
	sum := sha256.Sum256([]byte("return 1;"))
	allow := func(tool, input string) {
		recordApprovedScript(scope, Request{Action: Action{Tool: tool, Input: input}, Evidence: &Evidence{Script: &Script{Path: path, SHA256: hex.EncodeToString(sum[:])}}}, now)
	}
	args := map[string]any{"pid": float64(7)}
	allow("mcp__computer__run_script", `{"script_file":"/skills/site/scripts/read.js","args":{"pid":7}}`)
	if err := TakeApprovedScript(scope, path, "return 2;", args, now.Add(time.Second)); err == nil {
		t.Fatal("a body changed after review ran")
	}
	if err := TakeApprovedScript(scope, path, "return 1;", map[string]any{"pid": float64(8)}, now.Add(time.Second)); err == nil {
		t.Fatal("other args ran")
	}
	if err := TakeApprovedScript(scope, path, "return 1;", args, now.Add(time.Second)); err != nil {
		t.Fatalf("reviewed call: %v", err)
	}
	if err := TakeApprovedScript(scope, path, "return 1;", args, now.Add(time.Second)); err == nil {
		t.Fatal("one review ran twice")
	}
	allow("mcp__computer__run_script", `{"script_file":"/skills/site/scripts/read.js","args":{"pid":7}}`)
	if err := TakeApprovedScript(scope, path, "return 1;", args, now.Add(scriptApprovalBinding+time.Second)); err == nil {
		t.Fatal("an expired review ran")
	}
	// Another Context of the Agent does not take this Context's review.
	allow("mcp__computer__run_script", `{"script_file":"/skills/site/scripts/read.js","args":{"pid":7}}`)
	if err := TakeApprovedScript(ScriptScope("agent-1", "context-2"), path, "return 1;", args, now.Add(time.Second)); err == nil {
		t.Fatal("another Context ran this review")
	}
	if err := TakeApprovedScript(scope, path, "return 1;", args, now.Add(time.Second)); err != nil {
		t.Fatalf("own Context: %v", err)
	}
	// A Bash script's evidence does not allow run_script.
	allow("Bash", `{"command":"node /skills/site/scripts/read.js"}`)
	if err := TakeApprovedScript(scope, path, "return 1;", nil, now); err == nil {
		t.Fatal("Bash review ran a script")
	}
}

func TestInterleavedScriptReviewsRunOnlyReviewedBodyAndArgsPairs(t *testing.T) {
	now := time.Now()
	path := "/skills/site/scripts/write.js"
	scope := ScriptScope("agent-1", "context-9")
	allow := func(body, input string) {
		sum := sha256.Sum256([]byte(body))
		recordApprovedScript(scope, Request{Action: Action{Tool: "mcp__computer__run_script", Input: input}, Evidence: &Evidence{Script: &Script{Path: path, SHA256: hex.EncodeToString(sum[:])}}}, now)
	}
	// Call A was reviewed with the old body, the file then changed, and call B
	// was reviewed with the new body and other args. A, reading the new body
	// with its own args, matches no review.
	allow("read();", `{"script_file":"/skills/site/scripts/write.js","args":{"pid":1}}`)
	allow("write();", `{"script_file":"/skills/site/scripts/write.js","args":{"pid":2}}`)
	if err := TakeApprovedScript(scope, path, "write();", map[string]any{"pid": float64(1)}, now); err == nil {
		t.Fatal("call A ran a body reviewed only for call B's args")
	}
	// With the same args, the pair A runs is the pair B's review allowed, and
	// it runs once: B then needs a new review.
	allow("write();", `{"script_file":"/skills/site/scripts/write.js","args":{"pid":1}}`)
	if err := TakeApprovedScript(scope, path, "write();", map[string]any{"pid": float64(1)}, now); err != nil {
		t.Fatalf("reviewed pair: %v", err)
	}
	if err := TakeApprovedScript(scope, path, "write();", map[string]any{"pid": float64(1)}, now); err == nil {
		t.Fatal("one review ran twice")
	}
}
