package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProtocolProbeWaitsForInitializeBeforeClosingInput(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stdout, _, err := runBoundedProbe(context.Background(), executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "delayed"},
		`{"id":1,"method":"initialize"}`+"\n", 5*time.Second)
	if err != nil {
		t.Fatalf("probe failed: %v; output=%s", err, stdout)
	}
	if !strings.Contains(stdout, `{"id":1,"result":{"userAgent":"probe"}}`) {
		t.Fatalf("missing initialize result: %s", stdout)
	}
}

func TestProtocolProbeCancellationClosesUnresponsiveRuntime(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, _, err = runBoundedProbe(ctx, executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "unresponsive"},
		`{"id":1,"method":"initialize"}`+"\n", 5*time.Second)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("probe did not terminate within cleanup budget")
	}
}

func TestClaudeProtocolProbeRequiresMatchingInitialization(t *testing.T) {
	for _, test := range []struct {
		name, frame string
		matched     bool
	}{
		{"success", `{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}`, true},
		{"wrong request", `{"type":"control_response","response":{"subtype":"success","request_id":"another-request"}}`, false},
		{"rejected", `{"type":"control_response","response":{"subtype":"error","request_id":"linger-computer-doctor"}}`, false},
		{"session announcement", `{"type":"system","subtype":"init","session_id":"session"}`, false},
		{"missing response", `{"type":"control_response"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var frame map[string]any
			if err := json.Unmarshal([]byte(test.frame), &frame); err != nil {
				t.Fatal(err)
			}
			if got := protocolProbeResponseMatches("claude", frame); got != test.matched {
				t.Fatalf("matched = %v, want %v", got, test.matched)
			}
		})
	}
}

func TestClaudeProtocolProbeClosesInputAfterSplitInitialization(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = runBoundedProbe(context.Background(), executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "claude"},
		`{"type":"control_request","request_id":"linger-computer-doctor","request":{"subtype":"initialize"}}`+"\n", 5*time.Second)
	if err != nil {
		t.Fatalf("Claude initialize did not close stdin cleanly: %v", err)
	}
}

func TestProtocolProbeProcess(t *testing.T) {
	mode := os.Getenv("LINGER_TEST_PROTOCOL_HELPER")
	if mode == "" {
		return
	}
	decoder := json.NewDecoder(os.Stdin)
	var request map[string]any
	if decoder.Decode(&request) != nil {
		os.Exit(2)
	}
	closed := make(chan error, 1)
	go func() { closed <- decoder.Decode(&request) }()
	fmt.Println(`{"method":"starting"}`)
	if mode == "unresponsive" {
		<-closed
		os.Exit(3)
	}
	select {
	case <-closed:
		os.Exit(4)
	case <-time.After(400 * time.Millisecond):
	}
	if mode == "claude" {
		fmt.Print(`{"type":"control_response","response":`)
		time.Sleep(20 * time.Millisecond)
		fmt.Println(`{"subtype":"success","request_id":"linger-computer-doctor"}}`)
	} else {
		fmt.Print(`{"id":1,"res`)
		time.Sleep(20 * time.Millisecond)
		fmt.Println(`ult":{"userAgent":"probe"}}`)
	}
	if err := <-closed; !errors.Is(err, io.EOF) {
		os.Exit(5)
	}
	os.Exit(0)
}
