//go:build !windows

package native

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func codexCompactionItem() map[string]any {
	item := map[string]any{"id": "compact-1", "type": "contextCompaction"}
	return map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": item}}
}

func takeParkedForTest(t *testing.T, runtimeType, contextKey string) *ParkedSession {
	t.Helper()
	session := TakeParkedSession(runtimeType, contextKey)
	if session == nil {
		t.Fatalf("no parked %s session to compact", runtimeType)
	}
	if TakeParkedSession(runtimeType, contextKey) != nil {
		t.Fatal("a compacting process stayed in the resident table")
	}
	return session
}

func TestCodexCompactionParksTheProcessBack(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{
		{Status: "completed"},
		{Status: "completed", Items: []map[string]any{codexCompactionItem()}},
		{Status: "completed"},
	}, nil)
	rt := fake.scopedRuntime(nil, "ctx-compact", "agent-1")
	if TakeParkedSession("codex", "ctx-compact") != nil {
		t.Fatal("took a session before any process was parked")
	}
	spec := fake.spec()
	out, _ := codexDrain(t, rt, "one", spec)
	if out.Status != statusCompleted {
		t.Fatalf("first = %+v", out)
	}
	if TakeParkedSession("codex", "ctx-other") != nil || TakeParkedSession("claude", "ctx-compact") != nil {
		t.Fatal("took a process parked for another Context or Runtime")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := takeParkedForTest(t, "codex", "ctx-compact").Compact(ctx, "ignored by Codex")
	if result.Outcome != "compacted" || result.PreTokens != nil || result.Reason != "" {
		t.Fatalf("compaction = %+v", result)
	}
	requests := fake.requests("thread/compact/start")
	if len(requests) != 1 || requests[0]["params"].(map[string]any)["threadId"] != out.SessionID {
		t.Fatalf("thread/compact/start = %v", requests)
	}
	spec.ResumeID = out.SessionID
	out, events := codexDrain(t, rt, "two", spec)
	if out.Status != statusCompleted || codexReused(events) != "true" || fake.launchCount() != 1 || fake.count("turn/interrupt") != 0 {
		t.Fatalf("turn after compaction = %+v methods = %v", out, fake.methods())
	}
}

func TestCodexCompactionCancelInterruptsAndRetires(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed"}, {Stall: true}, {Status: "completed"}}, nil)
	rt := fake.scopedRuntime(nil, "ctx-compact", "agent-1")
	spec := fake.spec()
	out, _ := codexDrain(t, rt, "one", spec)
	session := takeParkedForTest(t, "codex", "ctx-compact")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan CompactResult, 1)
	go func() { done <- session.Compact(ctx, "") }()
	deadline := time.Now().Add(10 * time.Second)
	for fake.count("thread/compact/start") == 0 {
		if time.Now().After(deadline) {
			t.Fatal("compaction did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case result := <-done:
		if result.Outcome != "canceled" {
			t.Fatalf("canceled compaction = %+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("canceled compaction did not return")
	}
	if fake.count("turn/interrupt") != 1 || TakeParkedSession("codex", "ctx-compact") != nil {
		t.Fatalf("canceled compaction was not interrupted and retired: %v", fake.methods())
	}
	spec.ResumeID = out.SessionID
	if out, events := codexDrain(t, rt, "two", spec); out.Status != statusCompleted || codexReused(events) != "false" || fake.launchCount() != 2 {
		t.Fatalf("turn after canceled compaction = %+v launches = %d", out, fake.launchCount())
	}
}

func claudeCompactionHome(t *testing.T) *claudeResidentHome {
	t.Helper()
	claudeEnableResidency(t, 8)
	home := claudeNewResidentHome(t, nil)
	home.profile.ContextKey, home.profile.AgentID = "ctx-compact", "agent-1"
	return home
}

func TestClaudeCompactionParksTheProcessBack(t *testing.T) {
	home := claudeCompactionHome(t)
	home.turn(t, "one", RunSpec{})
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := takeParkedForTest(t, "claude", "ctx-compact").Compact(ctx, "keep the open questions")
	if result.Outcome != "compacted" || result.PreTokens == nil || *result.PreTokens != 44445 || result.Reason != "" {
		t.Fatalf("compaction = %+v", result)
	}
	compacts, _ := os.ReadFile(filepath.Join(home.dir, "compacts"))
	if strings.TrimSpace(string(compacts)) != "/compact keep the open questions" {
		t.Fatalf("compaction input = %q", compacts)
	}
	empty := takeParkedForTest(t, "claude", "ctx-compact").Compact(ctx, "empty")
	if empty.Outcome != "nothing_to_compact" || empty.PreTokens != nil {
		t.Fatalf("short session compaction = %+v", empty)
	}
	events, outcome := home.turn(t, "two", RunSpec{ResumeID: claudeTestSession})
	started := claudeTurnStarted(events)
	if outcome.Status != statusCompleted || started == nil || !*started.ProcessReused || len(home.pids(t)) != 1 {
		t.Fatalf("turn after compaction = %+v started = %+v pids = %v", outcome, started, home.pids(t))
	}
}

func TestClaudeCompactionCancelRetiresTheProcess(t *testing.T) {
	home := claudeCompactionHome(t)
	home.turn(t, "one", RunSpec{})
	session := takeParkedForTest(t, "claude", "ctx-compact")
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan CompactResult, 1)
	go func() { done <- session.Compact(ctx, "hang") }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		events, _ := os.ReadFile(filepath.Join(home.dir, "events"))
		if strings.Count(string(events), "user ") == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("compaction did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case result := <-done:
		if result.Outcome != "canceled" {
			t.Fatalf("canceled compaction = %+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("canceled compaction did not return")
	}
	// The process is gone before Compact returns.
	claudeAssertGone(t, home.pids(t))
	events, outcome := home.turn(t, "two", RunSpec{ResumeID: claudeTestSession})
	if started := claudeTurnStarted(events); outcome.Status != statusCompleted || started == nil || *started.ProcessReused || len(home.pids(t)) != 2 {
		t.Fatalf("turn after canceled compaction = %+v pids = %v", outcome, home.pids(t))
	}
}
