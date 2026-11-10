//go:build !windows

package native

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// codexSetupOrder is the order of the thread and naming requests on the wire.
func codexSetupOrder(fake *codexFake) []string {
	var order []string
	for _, method := range fake.methods() {
		switch method {
		case "thread/start", "thread/resume", "turn/start", "thread/name/set":
			order = append(order, method)
		}
	}
	return order
}

func TestCodexNamesNewThreadAfterTurnStart(t *testing.T) {
	// The fake holds turn/completed briefly so the deferred name request is
	// on the wire before the Operation ends.
	turn := []codexFakeTurn{{Status: "completed", DelayMs: 200}}
	t.Run("slow name answer", func(t *testing.T) {
		fake := newCodexFake(t, turn, map[string]string{"FAKE_MODES": "name_slow"})
		spec := fake.spec()
		spec.Title = "  Trip plan  "
		started := time.Now()
		out, _ := codexDrain(t, fake.runtime(nil), "go", spec)
		if elapsed := time.Since(started); out.Status != statusCompleted || elapsed >= 2*time.Second {
			t.Fatalf("outcome = %+v after %s", out, elapsed)
		}
		awaitTrue(t, "name request", 5*time.Second, func() bool { return fake.count("thread/name/set") == 1 })
		if order := codexSetupOrder(fake); !slices.Equal(order, []string{"thread/start", "turn/start", "thread/name/set"}) {
			t.Fatalf("order = %v", order)
		}
		if name := fake.requests("thread/name/set")[0]["params"].(map[string]any)["name"]; name != "Trip plan" {
			t.Fatalf("name = %v", name)
		}
	})
	t.Run("name rejected", func(t *testing.T) {
		fake := newCodexFake(t, turn, map[string]string{"FAKE_MODES": "reject_name"})
		log := &codexTestLog{}
		spec := fake.spec()
		spec.Title = "Trip plan"
		out, _ := codexDrain(t, fake.runtime(log.logger()), "go", spec)
		if out.Status != statusCompleted || out.Error != "" {
			t.Fatalf("outcome = %+v", out)
		}
		awaitTrue(t, "title warning", 5*time.Second, func() bool {
			return containsAll(log.String(), "thread_name_set_failure", "Codex session title unavailable")
		})
		if fake.count("thread/name/set") != 1 {
			t.Fatalf("methods = %v", fake.methods())
		}
	})
	t.Run("name never answered", func(t *testing.T) {
		fake := newCodexFake(t, turn, map[string]string{"FAKE_MODES": "name_hang"})
		codexResidentCapForTest(t, 0)
		spec := fake.spec()
		spec.Title, spec.StartupBudget = "Trip plan", 300*time.Millisecond
		out, _ := codexDrain(t, fake.runtime(nil), "go", spec)
		if out.Status != statusCompleted || out.Error != "" || out.ExitUnconfirmed || !out.ExitConfirmed || fake.count("thread/name/set") != 1 {
			t.Fatalf("outcome = %+v methods = %v", out, fake.methods())
		}
	})
	t.Run("untitled", func(t *testing.T) {
		fake := newCodexFake(t, nil, nil)
		if out, _ := codexDrain(t, fake.runtime(nil), "go", fake.spec()); out.Status != statusCompleted || fake.count("thread/name/set") != 0 {
			t.Fatalf("outcome = %+v methods = %v", out, fake.methods())
		}
	})
}

func TestCodexResumeKeepsName(t *testing.T) {
	fake := newCodexFake(t, []codexFakeTurn{{Status: "completed", DelayMs: 200}}, nil)
	rt := fake.runtime(nil)
	spec := fake.spec()
	spec.Title = "Trip plan"
	out, _ := codexDrain(t, rt, "one", spec)
	awaitTrue(t, "first name", 5*time.Second, func() bool { return fake.count("thread/name/set") == 1 })
	spec.ResumeID = out.SessionID
	// Reuse of the loaded thread counts as resumed.
	if out, _ := codexDrain(t, rt, "two", spec); out.Status != statusCompleted {
		t.Fatalf("reuse = %+v", out)
	}
	// A changed instruction rebinds through thread/resume.
	spec.AppendPrompt = "be brief"
	if out, _ := codexDrain(t, rt, "three", spec); out.Status != statusCompleted || fake.count("thread/resume") != 1 {
		t.Fatalf("resume = %+v methods = %v", out, fake.methods())
	}
	if fake.count("thread/name/set") != 1 {
		t.Fatalf("methods = %v", fake.methods())
	}
}

func TestCodexPrepareNamesBeforeReturning(t *testing.T) {
	for mode, status := range map[string]string{"normal": statusCompleted, "reject_name": statusFailed} {
		t.Run(mode, func(t *testing.T) {
			fake := newCodexFake(t, nil, map[string]string{"FAKE_MODES": mode})
			spec := fake.spec()
			spec.PrepareOnly = true
			out, _ := codexDrain(t, fake.runtime(nil), "", spec)
			if out.Status != status || fake.count("thread/name/set") != 1 || fake.count("turn/start") != 0 {
				t.Fatalf("outcome = %+v methods = %v", out, fake.methods())
			}
		})
	}
}

// codexStuckStdin blocks every write until it is closed.
type codexStuckStdin struct {
	once   sync.Once
	closed chan struct{}
	shut   atomic.Bool
}

func (s *codexStuckStdin) Write([]byte) (int, error) {
	<-s.closed
	return 0, errors.New("closed")
}

func (s *codexStuckStdin) Close() error {
	s.shut.Store(true)
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestCodexBestEffortRequestKeepsStdin(t *testing.T) {
	for _, bestEffort := range []bool{true, false} {
		stdin := &codexStuckStdin{closed: make(chan struct{})}
		transport := newCodexTransport(stdin)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		_, _, err := transport.call(ctx, "thread/name/set", map[string]any{}, 0, &codexCallHooks{bestEffort: bestEffort})
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("bestEffort=%v err = %v", bestEffort, err)
		}
		if stdin.shut.Load() == bestEffort {
			t.Fatalf("bestEffort=%v closed stdin = %v", bestEffort, stdin.shut.Load())
		}
		if transport.inflight() != 0 {
			t.Fatalf("bestEffort=%v left %d pending", bestEffort, transport.inflight())
		}
		_ = stdin.Close()
		transport.fail(errCodexChildGone)
	}
}
