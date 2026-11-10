package native

import (
	"testing"
	"time"
)

func modelResponses(events []Event) []ModelResponse {
	var responses []ModelResponse
	for _, event := range events {
		if event.Kind == EventModelResponse && event.Response != nil {
			responses = append(responses, *event.Response)
		}
	}
	return responses
}

// toolResultAt is when the adapter observed the result of call.
func toolResultAt(t *testing.T, events []Event, call string) time.Time {
	t.Helper()
	for _, event := range events {
		if event.Kind == EventToolOutput && event.InvocationID == call {
			if event.ObservedAt.IsZero() {
				t.Fatalf("tool result without a time: %+v", event)
			}
			return event.ObservedAt
		}
	}
	t.Fatalf("no result for %s", call)
	return time.Time{}
}

func requireRequestTimes(t *testing.T, response ModelResponse, observed time.Time) {
	t.Helper()
	if response.StartedAt.IsZero() || response.StartedAt.After(observed) ||
		(!response.FirstItemAt.IsZero() && (response.FirstItemAt.Before(response.StartedAt) || response.FirstItemAt.After(observed))) {
		t.Fatalf("request times = %+v observed %v", response, observed)
	}
}

func codexTokenUsage(thread, turn string, total, last int64) map[string]any {
	breakdown := func(tokens int64) map[string]any {
		return map[string]any{"inputTokens": tokens - 1, "cachedInputTokens": 0, "outputTokens": 1, "reasoningOutputTokens": 0, "totalTokens": tokens}
	}
	return map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{
		"threadId": thread, "turnId": turn, "tokenUsage": map[string]any{"total": breakdown(total), "last": breakdown(last)},
	}}
}

func codexItemNotice(method, thread, turn string, item map[string]any) map[string]any {
	return map[string]any{"method": method, "params": map[string]any{"threadId": thread, "turnId": turn, "item": item}}
}

// Every native response yields exactly one record, including a sub-agent's;
// a repeated usage snapshot is not a new request.
func TestCodexModelResponses(t *testing.T) {
	collab := map[string]any{"id": "collab-1", "type": "collabAgentToolCall", "tool": "spawnAgent", "status": "inProgress",
		"senderThreadId": "$THREAD", "receiverThreadIds": []string{}, "model": "sub-model", "agentsStates": map[string]any{}}
	spawnedChild := map[string]any{"id": "collab-1", "type": "collabAgentToolCall", "tool": "spawnAgent", "status": "completed",
		"senderThreadId": "$THREAD", "receiverThreadIds": []string{"child-1"}, "model": "sub-model", "agentsStates": map[string]any{}}
	waitCall := map[string]any{"id": "wait-1", "type": "collabAgentToolCall", "tool": "wait", "status": "completed",
		"senderThreadId": "$THREAD", "receiverThreadIds": []string{"child-1"}, "agentsStates": map[string]any{}}
	items := []map[string]any{
		codexItemNotice("item/started", "$THREAD", "$TURN", map[string]any{"id": "r1", "type": "reasoning", "summary": []string{}, "content": []string{}}),
		// Codex reports a response's usage after it ran that response's calls.
		codexItemNotice("item/started", "$THREAD", "$TURN", map[string]any{"id": "c1", "type": "commandExecution", "command": "ls", "status": "inProgress"}),
		codexItemNotice("item/completed", "$THREAD", "$TURN", map[string]any{"id": "c1", "type": "commandExecution", "command": "ls", "status": "completed", "aggregatedOutput": "x", "exitCode": 0}),
		codexTokenUsage("$THREAD", "$TURN", 100, 100),
		codexTokenUsage("$THREAD", "$TURN", 100, 100),
		codexItemNotice("item/started", "$THREAD", "$TURN", collab),
		codexItemNotice("item/completed", "$THREAD", "$TURN", spawnedChild),
		codexItemNotice("item/started", "child-1", "child-turn", map[string]any{"id": "child-msg", "type": "agentMessage", "text": ""}),
		codexTokenUsage("child-1", "child-turn", 30, 30),
		codexItemNotice("item/started", "child-1", "child-turn", map[string]any{"id": "child-cmd", "type": "commandExecution", "command": "ls", "status": "inProgress"}),
		codexItemNotice("item/completed", "child-1", "child-turn", map[string]any{"id": "child-cmd", "type": "commandExecution", "command": "ls", "status": "completed", "exitCode": 0}),
		codexItemNotice("item/started", "child-1", "child-turn", map[string]any{"id": "child-r", "type": "reasoning", "summary": []string{}, "content": []string{}}),
		codexTokenUsage("child-1", "child-turn", 45, 15),
		codexItemNotice("item/completed", "$THREAD", "$TURN", waitCall),
		codexAgentMessage("m1", "answer", nil),
		codexTokenUsage("$THREAD", "$TURN", 150, 50),
	}
	// The next turn on the same process repeats the last total before its
	// own request; the repeat is not a request.
	next := []map[string]any{
		codexTokenUsage("$THREAD", "$TURN", 150, 50),
		codexItemNotice("item/started", "$THREAD", "$TURN", map[string]any{"id": "r2", "type": "reasoning", "summary": []string{}, "content": []string{}}),
		codexTokenUsage("$THREAD", "$TURN", 170, 20),
	}
	fake := newCodexFake(t, []codexFakeTurn{{Items: items, Status: "completed"}, {Items: next, Status: "completed"}}, nil)
	spec := fake.spec()
	spec.Model = "main-model"
	spec.ExposeTurnStarted = true
	runtime := fake.runtime(nil)
	out, events := codexDrain(t, runtime, "hello", spec)
	if out.Status != statusCompleted {
		t.Fatalf("outcome = %+v", out)
	}
	responses := modelResponses(events)
	if len(responses) != 4 {
		t.Fatalf("responses = %+v", responses)
	}
	main, child := []ModelResponse{}, []ModelResponse{}
	for _, response := range responses {
		if response.Granularity != GranularityItem {
			t.Fatalf("granularity = %+v", response)
		}
		requireRequestTimes(t, response, time.Now())
		if response.Agent == "" {
			main = append(main, response)
		} else {
			child = append(child, response)
		}
	}
	if len(main) != 2 || main[0].Usage.Input != 99 || main[1].Usage.Input != 49 || main[0].Model != "main-model" || main[0].FirstItemAt.IsZero() ||
		main[1].FirstItemAt.IsZero() || main[1].StartedAt.Before(toolResultAt(t, events, "c1")) {
		t.Fatalf("main responses = %+v", main)
	}
	if len(child) != 2 || child[0].Agent != "child-1" || child[0].ParentCallID != "collab-1" || child[0].Model != "sub-model" || child[0].Usage.Input != 29 ||
		child[0].FirstItemAt.IsZero() || child[1].ParentCallID != "collab-1" || child[1].Usage.Input != 14 || child[1].StartedAt.Before(child[0].StartedAt) {
		t.Fatalf("child responses = %+v", child)
	}
	spec.ResumeID = "thread-1"
	if _, events = codexDrain(t, runtime, "again", spec); len(modelResponses(events)) != 1 || modelResponses(events)[0].Usage.Input != 19 {
		t.Fatalf("next turn responses = %+v", modelResponses(events))
	}
}

// A clock that starts with the Codex turn dispatch is only correct if the
// tool call a request issued does not move that request's start: Codex
// reports a response's usage after it ran the response's tool calls.
func TestCodexRequestKeepsItsStartAcrossItsOwnToolCall(t *testing.T) {
	pause := map[string]any{"method": "fake/pause", "ms": 40}
	items := []map[string]any{
		pause,
		codexItemNotice("item/started", "$THREAD", "$TURN", map[string]any{"id": "c1", "type": "commandExecution", "command": "ls", "status": "inProgress"}),
		pause,
		codexItemNotice("item/completed", "$THREAD", "$TURN", map[string]any{"id": "c1", "type": "commandExecution", "command": "ls", "status": "completed", "aggregatedOutput": "x", "exitCode": 0}),
		pause,
		codexTokenUsage("$THREAD", "$TURN", 100, 100),
		codexAgentMessage("m1", "answer", nil),
		codexTokenUsage("$THREAD", "$TURN", 150, 50),
	}
	fake := newCodexFake(t, []codexFakeTurn{{Items: items, Status: "completed"}}, nil)
	spec := fake.spec()
	spec.ExposeTurnStarted = true
	out, events := codexDrain(t, fake.runtime(nil), "hello", spec)
	if out.Status != statusCompleted {
		t.Fatalf("outcome = %+v", out)
	}
	responses := modelResponses(events)
	if len(responses) != 2 {
		t.Fatalf("responses = %+v", responses)
	}
	result := toolResultAt(t, events, "c1")
	if !responses[0].StartedAt.Before(result.Add(-60 * time.Millisecond)) {
		t.Fatalf("the request that issued the call starts at its result: %+v, result %v", responses[0], result)
	}
	if responses[1].StartedAt.Before(result) {
		t.Fatalf("the next request starts before the result it waits for: %+v, result %v", responses[1], result)
	}
}

// A Claude message streams one frame per content block, each repeating the
// message's usage. It is one request: counted once, at its last frame.
func TestClaudeModelResponses(t *testing.T) {
	frames := []string{
		`{"type":"system","subtype":"init","session_id":"87654321-4321-4321-8321-210987654321"}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-x","content":[{"type":"thinking","thinking":"plan","text":"plan"}],"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":5}}}`,
		`{"type":"assistant","message":{"id":"m1","model":"claude-x","content":[{"type":"tool_use","id":"t1","name":"Task","input":{"prompt":"look"}}],"usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":5}}}`,
		`{"type":"assistant","parent_tool_use_id":"t1","message":{"id":"s1","model":"claude-x","content":[{"type":"text","text":"sub"}],"usage":{"input_tokens":3,"output_tokens":1}}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"found"}]}}`,
		`{"type":"assistant","message":{"id":"m2","model":"claude-x","content":[{"type":"text","text":"answer"}],"usage":{"input_tokens":20,"output_tokens":4}}}`,
		`{"type":"assistant","message":{"id":"m3","model":"claude-x","content":[{"type":"text","text":"more"}],"usage":{"input_tokens":2,"output_tokens":1}}}`,
		`{"type":"assistant","error":"rate_limit","message":{"id":"m4","model":"<synthetic>","content":[{"type":"text","text":"API Error"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"answer","session_id":"87654321-4321-4321-8321-210987654321"}`,
	}
	events, outcome := claudeFinish(t, claudeStart(t, claudeFramesProfile(t, "frames", frames, nil), "hello", RunSpec{}), 10*time.Second)
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	responses := modelResponses(events)
	if len(responses) != 4 {
		t.Fatalf("responses = %+v", responses)
	}
	want := []struct {
		id, agent string
		usage     TokenCount
	}{
		{"m1", "", TokenCount{Input: 10, Output: 7, CacheRead: 5}},
		{"s1", "t1", TokenCount{Input: 3, Output: 1}},
		{"m2", "", TokenCount{Input: 20, Output: 4}},
		{"m3", "", TokenCount{Input: 2, Output: 1}},
	}
	for i, response := range responses {
		if response.MessageID != want[i].id || response.Agent != want[i].agent || response.Usage != want[i].usage ||
			response.Model != "claude-x" || response.Granularity != GranularityBlock || response.FirstItemAt.IsZero() {
			t.Fatalf("response %d = %+v", i, response)
		}
		if response.Agent != "" && response.ParentCallID != "t1" {
			t.Fatalf("sub-agent parent = %+v", response)
		}
		requireRequestTimes(t, response, time.Now())
	}
	if responses[2].StartedAt.Before(toolResultAt(t, events, "t1")) {
		t.Fatalf("request after the tool result started at %v", responses[2].StartedAt)
	}
	if outcome.Usage["claude-x"] != (TokenCount{Input: 35, Output: 13, CacheRead: 5}) || outcome.LastUsage["claude-x"] != (TokenCount{Input: 2, Output: 1}) {
		t.Fatalf("usage = %+v last = %+v", outcome.Usage, outcome.LastUsage)
	}
}

func TestPiModelResponses(t *testing.T) {
	h := piNewHarness(t, "requests", nil)
	events, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{}))
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	responses := modelResponses(events)
	if len(responses) != 2 {
		t.Fatalf("responses = %+v", responses)
	}
	for _, response := range responses {
		if response.Model != "fixture/model" || response.Granularity != GranularityDelta || response.Agent != "" || response.FirstItemAt.IsZero() {
			t.Fatalf("response = %+v", response)
		}
		requireRequestTimes(t, response, time.Now())
	}
	if responses[0].Usage != (TokenCount{Input: 4, Output: 1}) || responses[1].Usage != (TokenCount{Input: 2, Output: 3}) ||
		responses[1].StartedAt.Before(toolResultAt(t, events, piInvocationID("call_ls"))) {
		t.Fatalf("responses = %+v", responses)
	}
}
