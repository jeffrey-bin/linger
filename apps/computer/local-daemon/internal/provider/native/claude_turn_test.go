package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// claudeFakeGroup stands in for an owned process tree. It reports empty
// once killsBeforeEmpty SIGKILLs were sent; a negative value never empties.
type claudeFakeGroup struct {
	mu               sync.Mutex
	killsBeforeEmpty int
	kills            int
	released         bool
}

func (g *claudeFakeGroup) signal(sig syscall.Signal) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if sig == syscall.SIGKILL {
		g.kills++
	}
	return nil
}

func (g *claudeFakeGroup) waitEmpty(time.Duration) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.killsBeforeEmpty >= 0 && g.kills >= g.killsBeforeEmpty
}

func (g *claudeFakeGroup) release() {
	g.mu.Lock()
	g.released = true
	g.mu.Unlock()
}

func (g *claudeFakeGroup) setEmptyAfter(kills int) {
	g.mu.Lock()
	g.killsBeforeEmpty = kills
	g.mu.Unlock()
}

// claudeWire records the frames a harness turn writes to stdin.
type claudeWire struct {
	mu    sync.Mutex
	lines []string
	added chan struct{}
}

func (w *claudeWire) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.lines...)
}

func (w *claudeWire) await(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		if lines := w.snapshot(); len(lines) >= n {
			return lines
		}
		select {
		case <-w.added:
		case <-deadline:
			t.Fatalf("expected %d frames, have %v", n, w.snapshot())
		}
	}
}

// claudeHarness is a bound turn on a process with no child: tests feed
// frames as the reader would and observe what the adapter writes.
func claudeHarness(t *testing.T, spec RunSpec) (*claudeTurn, *claudeWire) {
	t.Helper()
	reader, writer := io.Pipe()
	wire := &claudeWire{added: make(chan struct{}, 1024)}
	go func() {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(nil, 1<<20)
		for scanner.Scan() {
			wire.mu.Lock()
			wire.lines = append(wire.lines, scanner.Text())
			wire.mu.Unlock()
			wire.added <- struct{}{}
		}
	}()
	p := claudeNewProcess(&claudeFakeGroup{}, claudeQuietLogger())
	p.stdin = writer
	ctx, cancel := context.WithCancel(context.Background())
	turn := claudeNewTurn(ctx, ctx, p, cancel, "prompt", claudeSpec(spec), Profile{Logger: claudeQuietLogger()}, false)
	close(turn.submitDone)
	p.conv.reset(turn, "turn-1")
	p.bind(turn)
	t.Cleanup(func() {
		cancel()
		p.cancel()
		_ = writer.Close()
	})
	return turn, wire
}

func claudeFeed(t *claudeTurn, frames ...string) {
	for _, frame := range frames {
		t.dispatchFrame([]byte(frame), time.Now())
	}
}

func claudePolicyFixture() *ClaudeToolPolicy {
	return &ClaudeToolPolicy{SkillNames: []string{"bound-skill", "inherited-skill"}, MCPToolNames: []string{"mcp__linger__send_message", "mcp__browser__browser_snapshot", "mcp__browser__browser_click"}}
}

func TestClaudeToolPolicyOnBothControlPaths(t *testing.T) {
	policy := claudePolicyFixture()
	cases := []struct {
		tool    string
		input   string
		agentID string
		allowed bool
	}{
		{"Read", `{"file_path":"x"}`, "", true},
		{"mcp__linger__send_message", `{}`, "", true},
		{"Skill", `{"skill":"bound-skill"}`, "", true},
		{"Skill", `{"skill":"inherited-skill"}`, "", true},
		{"Agent", `{"prompt":"x"}`, "", true},
		{"Bash", `{"command":"ls"}`, "", true},
		{"mcp__other__tool", `{}`, "", false},
		{"AskUserQuestion", `{}`, "", false},
		{"Skill", `{"skill":"other"}`, "", false},
		{"Skill", `{}`, "", false},
		{"Agent", `{"prompt":"x"}`, "agent-1", false},
		{"Agent", `{"background":true}`, "", false},
		{"Bash", `{"command":"ls","run_in_background":true}`, "", false},
	}
	for _, c := range cases {
		canUse := `{"subtype":"can_use_tool","tool_name":"` + c.tool + `","input":` + c.input + `,"agent_id":"` + c.agentID + `","tool_use_id":"tool-1"}`
		payload, err := claudeAuthorizeInline(policy, "req", json.RawMessage(canUse))
		if err != nil {
			t.Fatalf("%s: %v", c.tool, err)
		}
		encoded, _ := json.Marshal(payload)
		if c.allowed != strings.Contains(string(encoded), `"behavior":"allow"`) {
			t.Fatalf("can_use_tool %s %s = %s", c.tool, c.input, encoded)
		}
		if c.allowed && (!strings.Contains(string(encoded), `"toolUseID":"tool-1"`) || !strings.Contains(string(encoded), `"updatedInput":`+c.input)) {
			t.Fatalf("allow lost input or id: %s", encoded)
		}
		hook := `{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"PreToolUse","tool_name":"` + c.tool + `","tool_input":` + c.input + `,"agent_id":"` + c.agentID + `"}}`
		payload, err = claudeAuthorizeInline(policy, "req", json.RawMessage(hook))
		if err != nil {
			t.Fatalf("hook %s: %v", c.tool, err)
		}
		encoded, _ = json.Marshal(payload)
		want := `"permissionDecision":"deny"`
		if c.allowed {
			want = `"permissionDecision":"allow"`
		}
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("hook %s %s = %s", c.tool, c.input, encoded)
		}
	}
	envelope := claudeControlReply("req-7", map[string]any{})
	if !strings.Contains(string(envelope), `"type":"control_response"`) || !strings.Contains(string(envelope), `"subtype":"success"`) || !strings.Contains(string(envelope), `"request_id":"req-7"`) {
		t.Fatalf("envelope = %s", envelope)
	}
	for name, request := range map[string]string{
		"malformed":       `{`,
		"unknown subtype": `{"subtype":"mystery"}`,
		"null input":      `{"subtype":"can_use_tool","tool_name":"Read","input":null}`,
		"other callback":  `{"subtype":"hook_callback","callback_id":"hook_1","input":{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}}`,
		"post tool use":   `{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{}}}`,
		"null tool input": `{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":null}}`,
		"no request id":   "",
	} {
		id := "req"
		if name == "no request id" {
			id, request = "", `{"subtype":"can_use_tool","tool_name":"Read","input":{}}`
		}
		if _, err := claudeAuthorizeInline(policy, id, json.RawMessage(request)); err == nil {
			t.Fatalf("%s did not fail", name)
		}
	}
}

func TestClaudeInitializeFrameForEmptyPolicy(t *testing.T) {
	frame := claudeInitializeFrame(RunSpec{ClaudePolicy: &ClaudeToolPolicy{}, AppendPrompt: "extra"})
	var decoded struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype              string          `json:"subtype"`
			Skills               json.RawMessage `json:"skills"`
			AppendSystemPrompt   string          `json:"appendSystemPrompt"`
			SystemPromptSnapshot *bool           `json:"systemPromptSnapshot"`
			Hooks                map[string][]struct {
				HookCallbackIDs []string `json:"hookCallbackIds"`
			} `json:"hooks"`
		} `json:"request"`
	}
	if err := json.Unmarshal(frame, &decoded); err != nil {
		t.Fatal(err)
	}
	request := decoded.Request
	if decoded.RequestID != claudeInitializeRequestID || request.Subtype != "initialize" || string(request.Skills) != "[]" || request.AppendSystemPrompt != "extra" ||
		request.SystemPromptSnapshot == nil || *request.SystemPromptSnapshot || len(request.Hooks["PreToolUse"]) != 1 || request.Hooks["PreToolUse"][0].HookCallbackIDs[0] != "hook_0" {
		t.Fatalf("initialize = %s", frame)
	}
}

func TestClaudeReviewHookDecisions(t *testing.T) {
	policy := claudePolicyFixture()
	policy.ReviewPermissions = true
	for _, c := range []struct{ tool, input, decision string }{
		{"Bash", `{"command":"git push"}`, ""},
		{"Edit", `{"file_path":"x","old_string":"a","new_string":"b"}`, ""},
		{"mcp__browser__browser_snapshot", `{}`, ""},
		{"mcp__browser__browser_click", `{"ref":"e1"}`, "ask"},
		{"Bash", `{"command":"ls","run_in_background":true}`, "deny"},
		{"AskUserQuestion", `{}`, "deny"},
	} {
		hook := `{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"PreToolUse","tool_name":"` + c.tool + `","tool_input":` + c.input + `}}`
		payload, err := claudeAuthorizeInline(policy, "req", json.RawMessage(hook))
		if err != nil {
			t.Fatal(err)
		}
		output := payload.(map[string]any)["hookSpecificOutput"].(map[string]any)
		decision, _ := output["permissionDecision"].(string)
		if decision != c.decision {
			t.Fatalf("%s %s decision = %q", c.tool, c.input, decision)
		}
	}
}

// claudeReviewBridge is a permission requester that records requests.
func claudeReviewBridge() (*HumanInteractionBridge, chan Event) {
	requests := make(chan Event, 8)
	return NewHumanInteractionBridge(func(event Event) { requests <- event }), requests
}

func TestClaudeRoomPermissionReview(t *testing.T) {
	canUse := func(id, tool, input string) string {
		return `{"type":"control_request","request_id":"` + id + `","request":{"subtype":"can_use_tool","tool_name":"` + tool + `","input":` + input + `,"tool_use_id":"tool-1"}}`
	}
	bridge, requests := claudeReviewBridge()
	reviewer := &permission.Reviewer{Requester: bridge, Timeout: time.Minute}
	turn, wire := claudeHarness(t, RunSpec{PermissionReviewer: reviewer})

	claudeFeed(turn, canUse("r1", "Bash", `{"command":"git push"}`))
	request := <-requests
	if request.Input["kind"] != "permission_review" || len(wire.snapshot()) != 0 {
		t.Fatalf("request = %+v wire = %v", request, wire.snapshot())
	}
	if err := bridge.Respond(request.InvocationID, json.RawMessage(`{"decision":"allow"}`)); err != nil {
		t.Fatal(err)
	}
	line := wire.await(t, 1)[0]
	if !strings.Contains(line, `"request_id":"r1"`) || !strings.Contains(line, `"behavior":"allow"`) || !strings.Contains(line, `"toolUseID":"tool-1"`) {
		t.Fatalf("allow = %s", line)
	}

	claudeFeed(turn, canUse("r2", "Bash", `{"command":"git push"}`))
	request = <-requests
	_ = bridge.Respond(request.InvocationID, json.RawMessage(`{"decision":"needs_approval","message":"approval card sent"}`))
	if line := wire.await(t, 2)[1]; !strings.Contains(line, `"behavior":"deny"`) || !strings.Contains(line, "approval card sent") {
		t.Fatalf("needs approval = %s", line)
	}

	claudeFeed(turn, canUse("r3", "AskUserQuestion", `{}`))
	if line := wire.await(t, 3)[2]; !strings.Contains(line, `"behavior":"deny"`) || len(requests) != 0 {
		t.Fatalf("inline deny = %s", line)
	}

	claudeFeed(turn, canUse("r4", "Bash", `{"command":"git push"}`))
	request = <-requests
	claudeFeed(turn, `{"type":"control_cancel_request","request_id":"r4"}`)
	deadline := time.Now().Add(5 * time.Second)
	for bridge.Waiting() {
		if time.Now().After(deadline) {
			t.Fatal("withdrawal did not release the pending wait")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := bridge.Respond(request.InvocationID, json.RawMessage(`{"decision":"allow"}`)); err == nil {
		t.Fatal("a withdrawn review accepted an answer")
	}
	time.Sleep(50 * time.Millisecond)
	if len(wire.snapshot()) != 3 || turn.proc.conv.failureSummary() != "" || turn.proc.ctx.Err() != nil {
		t.Fatalf("withdrawal wrote or failed: %v %q", wire.snapshot(), turn.proc.conv.failureSummary())
	}

	claudeFeed(turn, canUse("r5", "Bash", `{"command":"git push"}`))
	request = <-requests
	_ = bridge.Respond(request.InvocationID, json.RawMessage(`{"decision":"deny","message":"no"}`))
	if line := wire.await(t, 4)[3]; !strings.Contains(line, `"behavior":"deny"`) {
		t.Fatalf("deny = %s", line)
	}

	claudeFeed(turn, `{"type":"control_request","request_id":"r6","request":{"subtype":"can_use_tool","tool_name":"Bash","input":null}}`)
	if turn.proc.conv.failureSummary() != claudePermissionInvalid {
		t.Fatalf("invalid request failure = %q", turn.proc.conv.failureSummary())
	}
}

func TestClaudeInlineAuthorizationFailureAborts(t *testing.T) {
	turn, _ := claudeHarness(t, RunSpec{})
	claudeFeed(turn, `{"type":"control_request","request_id":"x","request":{"subtype":"mystery"}}`)
	if turn.proc.conv.failureSummary() != claudeAuthorizeFailed || turn.proc.ctx.Err() == nil {
		t.Fatal("unknown control request did not abort the conversation")
	}
}

const claudeReplayOne = `{"type":"user","isReplay":true,"uuid":"turn-1","session_id":"s"}`

func claudeSteerAsync(turn *claudeTurn, ctx context.Context, expected string) chan error {
	done := make(chan error, 1)
	go func() {
		ack, err := turn.steer(ctx, SteerRequest{ExpectedTurnID: expected, Input: "more"})
		if err == nil && ack.TurnID != expected {
			err = errors.New("ack names " + ack.TurnID)
		}
		done <- err
	}()
	return done
}

func claudeFrameUUID(line string) string {
	var frame struct {
		UUID      string `json:"uuid"`
		RequestID string `json:"request_id"`
	}
	_ = json.Unmarshal([]byte(line), &frame)
	if frame.UUID != "" {
		return frame.UUID
	}
	return strings.TrimPrefix(frame.RequestID, claudeInterruptPrefix)
}

func TestClaudeSteerIgnoresOldResults(t *testing.T) {
	for _, oldBeforeAck := range []bool{true, false} {
		turn, wire := claudeHarness(t, RunSpec{})
		claudeFeed(turn, claudeReplayOne)
		done := claudeSteerAsync(turn, t.Context(), "turn-1")
		interrupt := wire.await(t, 1)[0]
		newID := claudeFrameUUID(interrupt)
		old := `{"type":"result","result":"old","terminal_reason":"completed","user_message_uuid":"turn-1"}`
		if oldBeforeAck {
			claudeFeed(turn, old)
		}
		claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+newID+`"}}`)
		wire.await(t, 2)
		if !oldBeforeAck {
			claudeFeed(turn, old)
		}
		if turn.terminal != nil {
			t.Fatal("an old result ended the replacement turn")
		}
		claudeFeed(turn, `{"type":"user","isReplay":true,"uuid":"`+newID+`"}`)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if turn.proc.conv.current() != newID {
			t.Fatal("native turn did not change")
		}
		claudeFeed(turn, `{"type":"result","result":"new","terminal_reason":"completed","user_message_uuid":"`+newID+`"}`)
		if turn.terminal == nil || turn.terminal.Result != "new" {
			t.Fatalf("replacement result not accepted: %+v", turn.terminal)
		}
	}
}

func TestClaudeSteerLostConfirmation(t *testing.T) {
	turn, wire := claudeHarness(t, RunSpec{})
	claudeFeed(turn, claudeReplayOne)
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	go func() {
		interrupt := wire.await(t, 1)[0]
		claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+claudeFrameUUID(interrupt)+`"}}`)
	}()
	_, err := turn.steer(ctx, SteerRequest{ExpectedTurnID: "turn-1", Input: "more"})
	var steerErr *SteerError
	if !errors.As(err, &steerErr) || steerErr.Effect != "uncertain" || steerErr.Reason != "transport" || !strings.Contains(steerErr.Message, "not confirmed") || !strings.Contains(steerErr.Message, "must not be retried") {
		t.Fatalf("err = %v", err)
	}
	if lines := wire.snapshot(); len(lines) != 2 || turn.proc.ctx.Err() == nil {
		t.Fatalf("lines = %v cancelled = %v", lines, turn.proc.ctx.Err())
	}
	if turn.proc.conv.finish() == "" {
		t.Fatal("finish reported no failure")
	}
	_, err = turn.steer(t.Context(), SteerRequest{ExpectedTurnID: "turn-1", Input: "again"})
	if !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || len(wire.snapshot()) != 2 {
		t.Fatalf("later steer = %v", err)
	}
}

func TestClaudeSteerWaitsForNativeConfirmation(t *testing.T) {
	previous := claudeSteerLimit
	claudeSteerLimit = 100 * time.Millisecond
	defer func() { claudeSteerLimit = previous }()
	turn, wire := claudeHarness(t, RunSpec{})
	claudeFeed(turn, claudeReplayOne)
	done := claudeSteerAsync(turn, t.Context(), "turn-1")
	newID := claudeFrameUUID(wire.await(t, 1)[0])
	claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+newID+`"}}`)
	wire.await(t, 2)
	// Confirmation arrives well after the submission limit.
	time.Sleep(300 * time.Millisecond)
	claudeFeed(turn, `{"type":"user","isReplay":true,"uuid":"turn-1"}`, `{"type":"user","isReplay":true,"parent_tool_use_id":"p","uuid":"`+newID+`"}`)
	select {
	case err := <-done:
		t.Fatalf("stale or child replay released the steer: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	claudeFeed(turn, `{"type":"user","isReplay":true,"uuid":"`+newID+`"}`)
	if err := <-done; err != nil || turn.proc.ctx.Err() != nil {
		t.Fatalf("steer = %v cancelled = %v", err, turn.proc.ctx.Err())
	}
	second := claudeSteerAsync(turn, t.Context(), "turn-1")
	otherID := claudeFrameUUID(wire.await(t, 3)[2])
	claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+otherID+`"}}`)
	wire.await(t, 4)
	claudeFeed(turn, `{"type":"user","isReplay":true,"uuid":"`+otherID+`"}`)
	if err := <-second; err != nil || otherID == newID {
		t.Fatalf("second steer = %v ids %s %s", err, newID, otherID)
	}
}

func TestClaudeSteerRefusals(t *testing.T) {
	turn, wire := claudeHarness(t, RunSpec{})
	var steerErr *SteerError
	if _, err := turn.steer(t.Context(), SteerRequest{ExpectedTurnID: "turn-1"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" {
		t.Fatalf("unconfirmed input steer = %v", err)
	}
	claudeFeed(turn, `{"type":"user","isReplay":true,"parent_tool_use_id":"p","uuid":"turn-1"}`)
	if _, err := turn.steer(t.Context(), SteerRequest{ExpectedTurnID: "turn-1"}); !errors.As(err, &steerErr) {
		t.Fatal("a child replay confirmed the root input")
	}
	claudeFeed(turn, `{"type":"result","parent_tool_use_id":"p","result":"child","terminal_reason":"completed"}`)
	if turn.terminal != nil {
		t.Fatal("a child result completed the turn")
	}
	claudeFeed(turn, claudeReplayOne)
	_, err := turn.steer(t.Context(), SteerRequest{ExpectedTurnID: "wrong"})
	if !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "no_active_turn" || steerErr.ActualTurnID != "turn-1" || len(wire.snapshot()) != 0 {
		t.Fatalf("wrong expected = %+v", err)
	}
}

func TestClaudeContinuationFinishingAfterResult(t *testing.T) {
	for range 100 {
		turn, wire := claudeHarness(t, RunSpec{})
		claudeFeed(turn, claudeReplayOne)
		done := claudeSteerAsync(turn, t.Context(), "turn-1")
		newID := claudeFrameUUID(wire.await(t, 1)[0])
		claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+newID+`"}}`)
		wire.await(t, 2)
		claudeFeed(turn, `{"type":"result","result":"old"}`, `{"type":"result","result":"new","user_message_uuid":"`+newID+`"}`)
		if failure := turn.proc.conv.finish(); failure != "" {
			t.Fatalf("finish = %q", failure)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestClaudeFinishWithUnconfirmedSteer(t *testing.T) {
	turn, wire := claudeHarness(t, RunSpec{})
	claudeFeed(turn, claudeReplayOne)
	done := claudeSteerAsync(turn, t.Context(), "turn-1")
	newID := claudeFrameUUID(wire.await(t, 1)[0])
	claudeFeed(turn, `{"type":"control_response","response":{"subtype":"success","request_id":"`+claudeInterruptPrefix+newID+`"}}`)
	wire.await(t, 2)
	first := turn.proc.conv.finish()
	if !strings.Contains(first, "not confirmed") || !strings.Contains(first, "must not be retried") || turn.proc.conv.finish() != first {
		t.Fatalf("finish = %q", first)
	}
	if err := <-done; err == nil {
		t.Fatal("waiter was not released with a failure")
	}
}

func TestClaudeEventDetails(t *testing.T) {
	turn, _ := claudeHarness(t, RunSpec{})
	before := time.Now()
	claudeFeed(turn,
		`{"type":"assistant","message":{"id":"progress","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a"}}]}}`,
		`{"type":"assistant","message":{"id":"answer","content":[{"type":"text","text":"The result "},{"type":"text","text":"is ready."}]}}`,
		`{"type":"assistant","message":{"id":"answer","content":[{"type":"text","text":" Done."}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"permission denied"}]}}`,
		`{"type":"tool_progress","tool_use_id":"t1","elapsed_time_seconds":123}`,
		`{"type":"log","log":{"level":"warn","message":"careful"}}`,
		`{"type":"system","subtype":"compact_boundary","session_id":"s2"}`,
	)
	after := time.Now()
	var events []Event
	for len(turn.events) > 0 {
		events = append(events, <-turn.events)
	}
	messages := map[string]string{}
	var order []string
	for _, event := range events {
		switch event.Kind {
		case EventText:
			if event.ModelMessageID != event.ID || event.ObservedAt.Before(before) || event.ObservedAt.After(after) {
				t.Fatalf("text event = %+v", event)
			}
			if _, seen := messages[event.ID]; !seen {
				order = append(order, event.ID)
			}
			messages[event.ID] += event.Body
		case EventToolCall:
			if event.ID != "" || event.ModelMessageID != "progress" || event.ObservedAt.IsZero() || event.Input["file_path"] != "a" {
				t.Fatalf("tool event = %+v", event)
			}
		case EventToolOutput:
			if event.Status != "failed" || event.InvocationID != "t1" || event.Output != `"permission denied"` {
				t.Fatalf("tool output = %+v", event)
			}
		case EventToolProgress:
			if event.Body != "2m3s" {
				t.Fatalf("progress = %+v", event)
			}
		case EventLog:
			if event.Level != "warn" || event.Body != "careful" {
				t.Fatalf("log = %+v", event)
			}
		case EventStatus:
			if event.SessionID != "s2" || event.TurnID != "" {
				t.Fatalf("status = %+v", event)
			}
		}
	}
	if len(order) != 2 || messages[order[1]] != "The result is ready. Done." || messages["progress"] != "Let me check." || turn.compactions != 1 {
		t.Fatalf("messages = %v order = %v", messages, order)
	}
}

func TestClaudeEventBackpressure(t *testing.T) {
	turn, _ := claudeHarness(t, RunSpec{})
	turn.events = make(chan Event, 1)
	var blocks []string
	for i := range 150 {
		blocks = append(blocks, `{"type":"text","text":"t`+strings.Repeat("x", i%3)+`"}`, `{"type":"tool_use","id":"tool","name":"Read","input":{}}`)
	}
	received := make(chan []EventKind)
	go func() {
		var kinds []EventKind
		for len(kinds) < 300 {
			kinds = append(kinds, (<-turn.events).Kind)
		}
		received <- kinds
	}()
	claudeFeed(turn, `{"type":"assistant","message":{"id":"m","content":[`+strings.Join(blocks, ",")+`]}}`)
	kinds := <-received
	for i, kind := range kinds {
		want := EventText
		if i%2 == 1 {
			want = EventToolCall
		}
		if kind != want {
			t.Fatalf("event %d = %s", i, kind)
		}
	}

	full, _ := claudeHarness(t, RunSpec{})
	full.events = make(chan Event, 1)
	full.events <- Event{Kind: EventLog, Body: "kept"}
	full.runCancel()
	started := time.Now()
	full.emit(Event{Kind: EventLog, Body: "dropped"})
	if time.Since(started) > time.Second || (<-full.events).Body != "kept" {
		t.Fatal("emit blocked or overwrote the buffered event")
	}
}
