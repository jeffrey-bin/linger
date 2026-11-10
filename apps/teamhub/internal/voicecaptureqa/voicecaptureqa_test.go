package voicecaptureqa

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

func TestBuildInputNumbersTranscript(t *testing.T) {
	segments := []Segment{{0, 4000, "The budget is set at 500k", ""}, {65000, 70000, " Lisa owns it ", ""}}
	input, first := BuildInput(" What is the budget? ", segments)
	if first != 1 {
		t.Fatalf("first=%d want=1", first)
	}
	for _, want := range []string{
		"Message: What is the budget?\n", "[1] 00:00 The budget is set at 500k\n", "[2] 01:05 Lisa owns it\n",
	} {
		if !strings.Contains(input, want) {
			t.Fatalf("input misses %q:\n%s", want, input)
		}
	}
	if strings.Contains(input, "omitted") {
		t.Fatalf("short transcript must not be trimmed:\n%s", input)
	}
}

func TestBuildInputKeepsMostRecentTranscript(t *testing.T) {
	long := strings.Repeat("€", transcriptBudgetRunes/2)
	segments := []Segment{{0, 1, "oldest", ""}, {1, 2, long, ""}, {2, 3, long, ""}, {3, 4, "latest", ""}}
	input, first := BuildInput("q", segments)
	if first != 3 {
		t.Fatalf("first=%d want=3", first)
	}
	if !strings.Contains(input, "earlier part of the recording is omitted") || strings.Contains(input, "oldest") ||
		strings.Contains(input, "[2]") || !strings.Contains(input, "[4] 00:00 latest") {
		t.Fatalf("unexpected trimmed input:\n%.300s", input)
	}
	if _, first := BuildInput("q", []Segment{{0, 1, strings.Repeat("a", transcriptBudgetRunes+1), ""}}); first != 1 {
		t.Fatalf("an oversize last line must stay, first=%d", first)
	}
}

func TestMapSourcesDropsInvalidNumbers(t *testing.T) {
	segments := []Segment{{0, 1, "a", ""}, {1, 2, "b", ""}, {2, 3, "c", ""}}
	got := MapSources([]int{0, 1, 3, 3, 4, -1, 2}, segments, 2)
	want := []Segment{{2, 3, "c", ""}, {1, 2, "b", ""}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sources=%v want=%v", got, want)
	}
	if got := MapSources(nil, segments, 1); got == nil || len(got) != 0 {
		t.Fatalf("no sources must be an empty list, got %#v", got)
	}
	if got := MapSources([]int{1, 2, 3, 1, 2, 3}, append(segments, segments...), 1); len(got) != 3 {
		t.Fatalf("sources=%v", got)
	}
}

func TestCutoffIsLastConfirmedEnd(t *testing.T) {
	if got := Cutoff(nil); got != 0 {
		t.Fatalf("empty cutoff=%d", got)
	}
	if got := Cutoff([]Segment{{0, 9000, "a", ""}, {5000, 7000, "b", ""}}); got != 9000 {
		t.Fatalf("cutoff=%d want=9000", got)
	}
}

func TestAnswererRequestsAStructuredAnswerFromTheRuntime(t *testing.T) {
	var payload struct {
		Route        json.RawMessage `json:"route"`
		Effort       *string         `json:"effort"`
		Owner        json.RawMessage `json:"owner"`
		Instructions string          `json:"instructions"`
		Input        string          `json:"input"`
		Output       struct {
			Name   string         `json:"name"`
			Schema map[string]any `json:"schema"`
		} `json:"output"`
		TimeoutMS int `json:"timeoutMs"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/model-calls" || r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("path=%s auth=%s", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		answer, _ := json.Marshal(map[string]any{"kind": "answer", "answer": " 500k ", "answered": true, "source_segments": []int{1, 9}, "task_title": ""})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"codex","output":` + string(answer) + `}`))
	}))
	defer server.Close()
	models, err := roomagent.NewModelCallClient(server.URL, "key")
	if err != nil {
		t.Fatal(err)
	}
	owner := roomagent.ModelCallOwner{TenantID: "tenant-a", OwnerActorID: "actor-recorder"}
	got, err := NewAnswerer(models, 45*time.Second).Answer(context.Background(), owner, "What is the budget?", []Segment{{0, 4000, "Budget 500k", ""}})
	if err != nil {
		t.Fatal(err)
	}
	want := Answer{Kind: KindAnswer, Text: "500k", Answered: true, Sources: []Segment{{StartOffsetMS: 0, EndOffsetMS: 4000, Text: "Budget 500k"}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("answer=%#v want=%#v", got, want)
	}
	if payload.Route != nil || payload.Effort != nil ||
		string(payload.Owner) != `{"ownerActorId":"actor-recorder","tenantId":"tenant-a"}` ||
		payload.Instructions != systemPrompt || !strings.Contains(payload.Input, "Budget 500k") ||
		payload.Output.Name != "voice_capture_answer" || payload.TimeoutMS != 45000 {
		t.Fatalf("unexpected payload: %+v", payload)
	}
	properties := payload.Output.Schema["properties"].(map[string]any)
	if kind := properties["kind"].(map[string]any)["enum"]; !reflect.DeepEqual(kind, []any{"answer", "task"}) {
		t.Fatalf("kind enum=%v", kind)
	}
}

func TestParseOutputRejectsEmptyAnswer(t *testing.T) {
	for _, raw := range []string{
		`{"kind":"answer","answer":"  ","answered":true,"source_segments":[],"task_title":""}`,
		`{"kind":"maybe","answer":"x","answered":true,"source_segments":[],"task_title":""}`,
		`not json`,
	} {
		if _, err := ParseOutput(raw, "q", nil, 1); err == nil {
			t.Fatalf("%s must fail", raw)
		}
	}
}

func TestParseOutputRecognizesTaskRequests(t *testing.T) {
	segments := []Segment{{0, 4000, "Lena needs the launch email", ""}}
	got, err := ParseOutput(`{"kind":"task","answer":"ignored","answered":false,"source_segments":[1],"task_title":"  Draft the launch email for Lena "}`,
		"Help me turn this into an email to Lena", segments, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := Answer{Kind: KindTask, Answered: true, Sources: segments, TaskTitle: "Draft the launch email for Lena"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("task=%#v want=%#v", got, want)
	}
	// A missing title falls back to the request, cut to a title's length.
	request := strings.Repeat("Remind me après ", 30)
	got, err = ParseOutput(`{"kind":"task","answer":"","answered":true,"source_segments":[],"task_title":" "}`, request, nil, 1)
	if err != nil || got.Kind != KindTask || len([]rune(got.TaskTitle)) != maxTaskTitleRunes || !strings.HasPrefix(got.TaskTitle, "Remind me après Remind me après") {
		t.Fatalf("fallback title=%q err=%v", got.TaskTitle, err)
	}
}

func TestPromptSeparatesQuestionsFromTasks(t *testing.T) {
	for _, want := range []string{`"task" only when the person asks for something to be done`, `When unsure, choose "answer"`, "Another Me"} {
		if !strings.Contains(systemPrompt, want) {
			t.Fatalf("prompt misses %q", want)
		}
	}
}

func TestBuildInputNamesSeparatedSpeakers(t *testing.T) {
	segments := []Segment{
		{StartOffsetMS: 1000, EndOffsetMS: 3000, Text: "The meeting recording is all here now.", Speaker: "spk_1"},
		{StartOffsetMS: 3200, EndOffsetMS: 5000, Text: "So you merged it all in.", Speaker: "spk_2"},
		{StartOffsetMS: 5200, EndOffsetMS: 6000, Text: "What's it for?", Speaker: "spk_1"},
	}
	input, _ := BuildInput("How many people are talking now?", segments)
	for _, want := range []string{
		"Speakers told apart by automatic speaker separation so far: Speaker 1, Speaker 2.",
		"[2] 00:03 Speaker 2: So you merged it all in.",
	} {
		if !strings.Contains(input, want) {
			t.Fatalf("input misses %q:\n%s", want, input)
		}
	}
	plain, _ := BuildInput("How many people?", []Segment{{StartOffsetMS: 0, EndOffsetMS: 1000, Text: "Hello"}})
	if !strings.Contains(plain, "does not tell speakers apart") {
		t.Fatalf("plain input = %s", plain)
	}
}
