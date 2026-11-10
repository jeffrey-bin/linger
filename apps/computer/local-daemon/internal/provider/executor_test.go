package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type fakeBackend struct {
	session   *native.Run
	onExecute func(native.RunSpec)
}

func TestPrepareMCPPreservesContextCause(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan native.Outcome, 1)
	messages := make(chan native.Event)
	close(messages)
	executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}, onExecute: func(native.RunSpec) {
			cancel()
			results <- native.Outcome{Status: "failed", Error: "MCP query canceled"}
			close(results)
		}}, nil
	}}
	_, err := executor.PrepareMCP(ctx, OperationSpec{Provider: "codex", ExecutablePath: "/bin/codex", WorkingDirectory: t.TempDir()})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("prepare lost context cancellation: %v", err)
	}
}

func (f fakeBackend) Start(_ context.Context, _ string, options native.RunSpec) (*native.Run, error) {
	if f.onExecute != nil {
		f.onExecute(options)
	}
	return f.session, nil
}

func TestExecutorMapsProviderEventsAndResult(t *testing.T) {
	messages := make(chan native.Event, 1)
	results := make(chan native.Outcome, 1)
	messages <- native.Event{Kind: native.EventText, Body: "hello"}
	close(messages)
	results <- native.Outcome{Status: "completed", Output: "done", SessionID: "thread-1"}
	close(results)

	var events []protocol.Event
	executor := Executor{
		NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		},
	}
	execution, err := executor.Start(context.Background(), OperationSpec{
		Provider:         "codex",
		ExecutablePath:   "/bin/codex",
		WorkingDirectory: "/tmp",
		Prompt:           "hello",
		Timeout:          10 * time.Second,
	}, func(_ context.Context, event protocol.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	result := <-execution.Result
	if result.Status != "completed" || result.Output != "done" || result.SessionID != "thread-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(events) != 1 || events[0].Type != protocol.EventOperationEvent {
		t.Fatalf("unexpected events: %+v", events)
	}
	var normalized map[string]any
	if err := json.Unmarshal(events[0].Payload, &normalized); err != nil {
		t.Fatal(err)
	}
	if normalized["type"] != "message.delta" || normalized["delta"] != "hello" {
		t.Fatalf("provider event was not normalized for Runner Gateway: %+v", normalized)
	}
}

func TestExecutorPreservesCleanupFailureAfterEventWriteFailure(t *testing.T) {
	messages := make(chan native.Event, 1)
	messages <- native.Event{Kind: native.EventText, Body: "partial"}
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "failed", ExitUnconfirmed: true}
	close(results)
	executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
	}}
	execution, err := executor.Start(t.Context(), OperationSpec{
		OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/codex",
		WorkingDirectory: t.TempDir(), TaskID: "cleanup-event-failure",
	}, func(context.Context, protocol.Event) error {
		return errors.New("event ledger unavailable")
	})
	if err != nil {
		t.Fatal(err)
	}
	result := <-execution.Result
	if result.Status != "failed" || !result.CleanupUnconfirmed || !strings.Contains(result.Error, "event ledger unavailable") {
		t.Fatalf("event failure lost cleanup evidence: %+v", result)
	}
}

func TestExecutorSynthesizesResultOnlyRunOutput(t *testing.T) {
	messages := make(chan native.Event, 1)
	messages <- native.Event{Kind: native.EventStatus, Status: "running", TurnID: "native-turn"}
	results := make(chan native.Outcome, 1)
	close(messages)
	results <- native.Outcome{Status: "completed", Output: "final only", SessionID: "session-1"}
	close(results)

	var events []protocol.Event
	executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
	}}
	execution, err := executor.Start(context.Background(), OperationSpec{
		OperationKind: "run.start", Provider: "claude", ExecutablePath: "/bin/claude",
		WorkingDirectory: "/tmp", TaskID: "run-result-only",
	}, func(_ context.Context, event protocol.Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	result := <-execution.Result
	if result.Status != "completed" || result.Output != "final only" || result.SessionID != "session-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(events) != 2 {
		t.Fatalf("events=%+v, want native start and final output", events)
	}
	var started, delta map[string]any
	if err := json.Unmarshal(events[0].Payload, &started); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(events[1].Payload, &delta); err != nil {
		t.Fatal(err)
	}
	if started["type"] != "run.started" || started["turn_id"] != "native-turn" || delta["type"] != "message.delta" || delta["delta"] != "final only" || delta["message_id"] == "" {
		t.Fatalf("unexpected normalized events: started=%+v delta=%+v", started, delta)
	}
}

func TestNormalizeMessagePreservesProviderMessageIdentity(t *testing.T) {
	first := normalizeMessage(native.Event{
		Kind: native.EventText, ID: "message-progress", Body: "working",
	}, "operation-1").(map[string]any)
	final := normalizeMessage(native.Event{
		Kind: native.EventText, ID: "message-final", Body: "done",
	}, "operation-1").(map[string]any)

	if first["message_id"] != "message-progress" || final["message_id"] != "message-final" {
		t.Fatalf("provider message identity was not preserved: first=%+v final=%+v", first, final)
	}
}

func TestExecutorRequiresLingerEventEmitter(t *testing.T) {
	_, err := (Executor{}).Start(context.Background(), OperationSpec{
		Provider:       "codex",
		ExecutablePath: "/bin/codex",
	}, nil)
	if err == nil || err.Error() != "provider executor requires an event emitter" {
		t.Fatal("expected missing emitter error")
	}
}

func TestExecutorOwnsOperationTempDirectoryUntilProviderCleanup(t *testing.T) {
	base := filepath.Join(t.TempDir(), "operation-tmp")
	messages := make(chan native.Event)
	close(messages)
	results := make(chan native.Outcome, 1)
	configured := make(chan string, 1)
	executor := Executor{
		TempBase: base,
		NewBackend: func(_ string, config native.Profile) (native.Runtime, error) {
			temp := config.Env["TMPDIR"]
			if temp == "" || config.Env["TMP"] != temp || config.Env["TEMP"] != temp {
				return nil, errors.New("Operation temp environment is inconsistent")
			}
			configured <- temp
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
		},
	}
	execution, err := executor.Start(context.Background(), OperationSpec{
		Provider: "codex", ExecutablePath: "/bin/codex", WorkingDirectory: "/tmp",
		Environment: map[string]string{"PATH": "/bin"}, OperationKind: "run.start",
	}, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	temp := <-configured
	if relative, err := filepath.Rel(base, temp); err != nil || relative == "." || filepath.IsAbs(relative) || relative == ".." {
		t.Fatalf("Operation temp path = %q relative=%q err=%v", temp, relative, err)
	}
	if info, err := os.Stat(temp); err != nil || !info.IsDir() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0o700) {
		t.Fatalf("Operation temp directory info = %+v err=%v", info, err)
	}
	if runtime.GOOS == "windows" {
		if err := privatefs.CheckPath(temp, "directory", true); err != nil {
			t.Fatalf("Operation temp directory ACL: %v", err)
		}
	}
	results <- native.Outcome{Status: "completed", Output: "done"}
	close(results)
	if result := <-execution.Result; result.Status != "completed" {
		t.Fatalf("Provider result = %+v", result)
	}
	if _, err := os.Stat(temp); !os.IsNotExist(err) {
		t.Fatalf("Operation temp survived Provider cleanup: %v", err)
	}
}

func TestExecutorPreservesFailureDiagnostics(t *testing.T) {
	diagnostics := native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: new(429), ExitCode: new(3), Signal: "SIGSEGV"}
	messages := make(chan native.Event)
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "failed", Error: "failed", Diagnostics: diagnostics}
	close(results)
	executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
	}}
	execution, err := executor.Start(t.Context(), OperationSpec{Provider: "codex", ExecutablePath: "/bin/codex", WorkingDirectory: t.TempDir(), Prompt: "prompt"}, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	result := <-execution.Result
	encoded, _ := json.Marshal(result.Diagnostics)
	want, _ := json.Marshal(diagnostics)
	if string(encoded) != string(want) {
		t.Fatalf("diagnostics=%s want=%s", encoded, want)
	}
}

type sequenceBackend struct {
	runs  []*native.Run
	specs *[]native.RunSpec
}

func (b sequenceBackend) Start(_ context.Context, _ string, options native.RunSpec) (*native.Run, error) {
	*b.specs = append(*b.specs, options)
	if len(*b.specs) > len(b.runs) {
		return nil, errors.New("unexpected native start")
	}
	return b.runs[len(*b.specs)-1], nil
}

func finishedRun(outcome native.Outcome, events ...native.Event) *native.Run {
	messages := make(chan native.Event, len(events))
	for _, event := range events {
		messages <- event
	}
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- outcome
	close(results)
	return &native.Run{Events: messages, Outcome: results}
}

func TestExecutorStartsFreshSessionWhenRetainedSessionIsMissing(t *testing.T) {
	for _, provider := range []string{"codex", "claude"} {
		t.Run(provider, func(t *testing.T) {
			var specs []native.RunSpec
			executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
				return sequenceBackend{specs: &specs, runs: []*native.Run{
					finishedRun(native.Outcome{Status: "failed", FailureCode: "session_not_found", Error: "session history could not be restored"}),
					finishedRun(native.Outcome{Status: "completed", Output: "hello", SessionID: "fresh-session"}, native.Event{Kind: native.EventText, Body: "hello"}),
				}}, nil
			}}
			execution, err := executor.Start(t.Context(), OperationSpec{
				OperationKind: "run.start", Provider: provider, ExecutablePath: "/bin/" + provider,
				WorkingDirectory: t.TempDir(), TaskID: "fresh-" + provider, ResumeSessionID: "legacy-session",
			}, func(context.Context, protocol.Event) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			result := <-execution.Result
			if result.Status != "completed" || result.SessionID != "fresh-session" {
				t.Fatalf("result=%+v, want completed fresh session", result)
			}
			if len(specs) != 2 || specs[0].ResumeID != "legacy-session" || !specs[0].ResumeRequired || specs[1].ResumeID != "" || specs[1].ResumeRequired {
				t.Fatalf("native starts=%+v, want one resume then one fresh start", specs)
			}
			if (provider == "claude") != (specs[1].AssignSessionID != "") {
				t.Fatalf("fresh start assigned session %q for %s", specs[1].AssignSessionID, provider)
			}
		})
	}
}

func TestExecutorDoesNotRepeatFreshSessionFallback(t *testing.T) {
	missing := native.Outcome{Status: "failed", FailureCode: "session_not_found", Error: "missing"}
	cases := map[string]struct {
		spec   OperationSpec
		runs   []*native.Run
		starts int
	}{
		"second refusal fails": {
			spec:   OperationSpec{OperationKind: "run.start", ResumeSessionID: "legacy"},
			runs:   []*native.Run{finishedRun(missing), finishedRun(missing)},
			starts: 2,
		},
		"events already emitted": {
			spec:   OperationSpec{OperationKind: "run.start", ResumeSessionID: "legacy"},
			runs:   []*native.Run{finishedRun(missing, native.Event{Kind: native.EventText, Body: "partial"})},
			starts: 1,
		},
		"new session": {
			spec:   OperationSpec{OperationKind: "run.start"},
			runs:   []*native.Run{finishedRun(missing)},
			starts: 1,
		},
		"model invoke": {
			spec:   OperationSpec{OperationKind: "model.invoke", ResumeSessionID: "legacy"},
			runs:   []*native.Run{finishedRun(missing)},
			starts: 1,
		},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			var specs []native.RunSpec
			executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
				return sequenceBackend{specs: &specs, runs: test.runs}, nil
			}}
			spec := test.spec
			spec.Provider, spec.ExecutablePath, spec.WorkingDirectory, spec.TaskID = "codex", "/bin/codex", t.TempDir(), "no-repeat"
			execution, err := executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			result := <-execution.Result
			if result.Status != "failed" || result.FailureCode != "session_not_found" || len(specs) != test.starts {
				t.Fatalf("result=%+v starts=%d, want session_not_found after %d starts", result, len(specs), test.starts)
			}
		})
	}
}
