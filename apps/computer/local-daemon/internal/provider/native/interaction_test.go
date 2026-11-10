package native

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestHumanInteractionBridge(t *testing.T) {
	var events []Event
	bridge := NewHumanInteractionBridge(func(event Event) { events = append(events, event) })
	var answered []string
	if err := bridge.Request("r1", map[string]any{"kind": "native_question"}, func(payload json.RawMessage) error {
		answered = append(answered, string(payload))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Kind != EventHumanPrompt || events[0].InvocationID != "r1" || events[0].Input["request_id"] != "r1" {
		t.Fatalf("events = %+v", events)
	}
	if err := bridge.Request("r1", map[string]any{}, nil); err == nil || err.Error() != "Runtime request is already pending" {
		t.Fatalf("duplicate error = %v", err)
	}
	if !bridge.Waiting() {
		t.Fatal("bridge must be waiting")
	}
	if err := bridge.Respond("r1", json.RawMessage(`{"ok":true}`)); err != nil || !reflect.DeepEqual(answered, []string{`{"ok":true}`}) {
		t.Fatalf("respond = %v, %q", err, answered)
	}
	var steer *SteerError
	if err := bridge.Respond("r1", nil); !errors.As(err, &steer) || steer.Effect != "definitely_not_applied" || steer.Reason != "no_active_turn" || steer.Message != "Runtime interaction is no longer pending" {
		t.Fatalf("second respond = %#v", err)
	}
	if bridge.Waiting() {
		t.Fatal("answered bridge still waiting")
	}
	_ = bridge.Request("forget", nil, func(json.RawMessage) error { t.Fatal("forgotten callback ran"); return nil })
	bridge.Forget("forget")
	if bridge.Waiting() {
		t.Fatal("forgotten request still waiting")
	}
	for i := range interactionCapacity {
		if err := bridge.Request(string(rune('a'+i)), nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := bridge.Request("overflow", nil, nil); err == nil || err.Error() != "Runtime interaction capacity is unavailable" {
		t.Fatalf("capacity error = %v", err)
	}
	bridge.Close()
	if bridge.Waiting() || bridge.Request("late", nil, nil) == nil || bridge.Respond("a", nil) == nil {
		t.Fatal("closed bridge accepted work")
	}
}

func TestCodexQuestionMapping(t *testing.T) {
	questions := []codexQuestion{
		{ID: "choice", Question: "Keep it?", Options: []codexQuestionOption{{Label: "Keep"}, {Label: "Delete"}}},
		{ID: "other", Question: "Why?", IsOther: true, Options: []codexQuestionOption{{Label: "A", Description: "first"}}},
		{ID: "free", Question: "Notes"},
	}
	request, ok := codexQuestionRequest(questions)
	if !ok {
		t.Fatal("form refused")
	}
	encoded, _ := json.Marshal(request)
	want := `{"form":{"questions":[` +
		`{"id":"choice","input":"radio","options":[{"id":"0","label":"Keep"},{"id":"1","label":"Delete"}],"prompt":"Keep it?"},` +
		`{"id":"other","input":"text","prompt":"Why?\nA: first"},` +
		`{"id":"free","input":"text","prompt":"Notes"}],"type":"questions"},"kind":"native_question","prompt":"Answer the Agent's question"}`
	if string(encoded) != want {
		t.Fatalf("request = %s", encoded)
	}
	if _, ok := codexQuestionRequest([]codexQuestion{{ID: "s", IsSecret: true}}); ok {
		t.Fatal("secret question produced a form")
	}
	answers, err := codexQuestionAnswers(questions[:1], json.RawMessage(`{"decision":"submit","answers":{"choice":"1"}}`))
	if encoded, _ := json.Marshal(answers); err != nil || string(encoded) != `{"answers":{"choice":{"answers":["Delete"]}}}` {
		t.Fatalf("answers = %s, %v", encoded, err)
	}
	answers, _ = codexQuestionAnswers(questions, json.RawMessage(`{"decision":"dismiss","answers":{"choice":"1"}}`))
	if encoded, _ := json.Marshal(answers); string(encoded) != `{"answers":{"choice":{"answers":[]},"free":{"answers":[]},"other":{"answers":[]}}}` {
		t.Fatalf("dismissed answers = %s", encoded)
	}
	answers, _ = codexQuestionAnswers(questions[1:2], json.RawMessage(`{"decision":"submit","answers":{"other":"0"}}`))
	if encoded, _ := json.Marshal(answers); string(encoded) != `{"answers":{"other":{"answers":["0"]}}}` {
		t.Fatalf("other answers = %s", encoded)
	}
	if codexQuestionRequestID(json.RawMessage(`123`)) != "codex-123" || codexQuestionRequestID(json.RawMessage(`"request-string"`)) != `codex-"request-string"` {
		t.Fatal("request id must keep the raw JSON id")
	}
	if err := questionTurnEnded(); err.Effect != "definitely_not_applied" || err.Reason != "no_active_turn" || err.Message != "Original question turn has ended" {
		t.Fatalf("turn ended = %+v", err)
	}
}
