package permission

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRequester struct {
	mu        sync.Mutex
	requests  map[string]map[string]any
	responds  map[string]func(json.RawMessage) error
	forgotten []string
	sent      chan string
	err       error
}

func newFakeRequester() *fakeRequester {
	return &fakeRequester{requests: map[string]map[string]any{}, responds: map[string]func(json.RawMessage) error{}, sent: make(chan string, 1)}
}

func (f *fakeRequester) Request(id string, request map[string]any, respond func(json.RawMessage) error) error {
	if f.err != nil {
		return f.err
	}
	f.mu.Lock()
	f.requests[id], f.responds[id] = request, respond
	f.mu.Unlock()
	f.sent <- id
	return nil
}

func (f *fakeRequester) Forget(id string) {
	f.mu.Lock()
	f.forgotten = append(f.forgotten, id)
	f.mu.Unlock()
}

func (f *fakeRequester) answer(t *testing.T, id, raw string) {
	t.Helper()
	f.mu.Lock()
	respond := f.responds[id]
	f.mu.Unlock()
	if err := respond(json.RawMessage(raw)); err != nil {
		t.Fatal(err)
	}
}

func review(reviewer *Reviewer, request Request) <-chan Verdict {
	verdict := make(chan Verdict, 1)
	go func() { verdict <- reviewer.Review(context.Background(), request) }()
	return verdict
}

func TestReviewerAllowsReadOnlyLocalToolsWithoutAsking(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester}
	for _, action := range []Action{
		{Tool: "mcp__browser__browser_snapshot", Input: `{}`},
		{Tool: "mcp__computer__get_window_state", Input: `{}`},
		{Tool: "mcp__browser__browser_tabs", Input: `{"action":"list"}`},
		{Tool: "mcp__browser__browser_tabs", Input: `{"action":"select","index":1}`},
		{Tool: "mcp__browser__browser_navigate_back", Input: `{}`},
		{Tool: "mcp__computer__check_permissions", Input: `{}`},
	} {
		if verdict := reviewer.Review(context.Background(), Request{Action: action}); verdict.Decision != Allow {
			t.Fatalf("%s: %+v", action.Tool, verdict)
		}
	}
	if len(requester.requests) != 0 {
		t.Fatalf("read-only tools were sent for review: %v", requester.requests)
	}
}

func TestReviewerAllowsLocalCallsThatFollowWhatTheAgentSaw(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, LocalAllowed: func(tool, input string) bool {
		return tool == "mcp__browser__browser_navigate" && input == `{"url":"https://example.com/next"}`
	}}
	follow := Action{Tool: "mcp__browser__browser_navigate", Input: `{"url":"https://example.com/next"}`}
	if verdict := reviewer.Review(context.Background(), Request{Action: follow}); verdict.Decision != Allow || len(requester.requests) != 0 {
		t.Fatalf("verdict = %+v, requests = %v", verdict, requester.requests)
	}
	elsewhere := Action{Tool: "mcp__browser__browser_navigate", Input: `{"url":"https://evil.example/"}`}
	verdict := review(reviewer, Request{Action: elsewhere})
	requester.answer(t, <-requester.sent, `{"decision":"needs_approval"}`)
	if got := <-verdict; got.Decision != NeedsApproval {
		t.Fatalf("a navigation away from the page: %+v", got)
	}
}

func TestReviewerAllowsTeamHubCommandsTheRuntimeRulesMissed(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, TeamHubCommands: []TeamHubCommand{{Path: []string{"message", "send"}}}}
	send := Action{Tool: "Bash", Command: "teamhub message send --room room_x --file - << 'EOF'\nhello\nEOF"}
	if verdict := reviewer.Review(context.Background(), Request{Action: send}); verdict.Decision != Allow {
		t.Fatalf("verdict = %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("an allowed TeamHub command was sent for review: %v", requester.requests)
	}
}

func TestReviewerSendsTheReviewAndReturnsTheVerdict(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, Environment: Environment{RuntimeVersion: "2.1.282", Workspace: "/work"}}
	verdict := review(reviewer, Request{Action: Action{Runtime: "claude", Surface: "shell", Tool: "Bash", Command: "git push"}})
	id := <-requester.sent
	payload := requester.requests[id]
	encoded, _ := json.Marshal(payload)
	if payload["kind"] != "permission_review" || payload["action"].(map[string]any)["command"] != "git push" ||
		payload["environment"].(map[string]any)["workspace"] != "/work" {
		t.Fatalf("review payload: %s", encoded)
	}
	requester.answer(t, id, `{"decision":"needs_approval","message":"Approval card sent","interaction_id":"card-1"}`)
	if got := <-verdict; got != (Verdict{Decision: NeedsApproval, Message: "Approval card sent", InteractionID: "card-1"}) {
		t.Fatalf("verdict: %+v", got)
	}
}

func TestReviewerFailsClosed(t *testing.T) {
	bash := Request{Action: Action{Tool: "Bash", Command: "git push"}}
	t.Run("invalid answer", func(t *testing.T) {
		requester := newFakeRequester()
		verdict := review(&Reviewer{Requester: requester}, bash)
		requester.answer(t, <-requester.sent, `{"decision":"maybe"}`)
		if got := <-verdict; got.Decision != Unavailable || got.Message == "" {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("deny without a message", func(t *testing.T) {
		requester := newFakeRequester()
		verdict := review(&Reviewer{Requester: requester}, bash)
		requester.answer(t, <-requester.sent, `{"decision":"deny"}`)
		if got := <-verdict; got.Decision != Deny || got.Message == "" {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("request fails", func(t *testing.T) {
		requester := newFakeRequester()
		requester.err = errors.New("bridge closed")
		if got := (&Reviewer{Requester: requester}).Review(context.Background(), bash); got.Decision != Unavailable {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		requester := newFakeRequester()
		got := (&Reviewer{Requester: requester, Timeout: 10 * time.Millisecond}).Review(context.Background(), bash)
		id := <-requester.sent
		if got.Decision != Unavailable || len(requester.forgotten) != 1 || requester.forgotten[0] != id {
			t.Fatalf("verdict %+v forgotten %v", got, requester.forgotten)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		requester := newFakeRequester()
		ctx, cancel := context.WithCancel(context.Background())
		verdict := make(chan Verdict, 1)
		go func() { verdict <- (&Reviewer{Requester: requester}).Review(ctx, bash) }()
		<-requester.sent
		cancel()
		if got := <-verdict; got.Decision != Unavailable || len(requester.forgotten) != 1 {
			t.Fatalf("verdict %+v forgotten %v", got, requester.forgotten)
		}
	})
}

func TestReviewerAttachesLocalEvidenceToBrowserAndDesktopActions(t *testing.T) {
	requester := newFakeRequester()
	var asked []string
	reviewer := &Reviewer{Requester: requester, LocalEvidence: func(_ context.Context, tool, input string) *Evidence {
		asked = append(asked, tool)
		return &Evidence{Desktop: &Desktop{App: "Mail", Targets: []DesktopTarget{{Token: "s1:3", Role: "AXButton", Name: "Send"}}},
			Screenshot: &Screenshot{MediaType: "image/jpeg", Data: "AA==", Width: 1, Height: 1}}
	}}
	review(reviewer, Request{Action: Action{Tool: "mcp__computer__get_window_state", Input: `{}`}})
	verdict := review(reviewer, Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":1,"element_token":"s1:3"}`}})
	id := <-requester.sent
	payload := requester.requests[id]
	evidence, _ := payload["evidence"].(map[string]any)
	desktop, _ := evidence["desktop"].(map[string]any)
	if desktop["app"] != "Mail" || evidence["screenshot"] == nil {
		t.Fatalf("evidence: %v", evidence)
	}
	if len(asked) != 1 || asked[0] != "mcp__computer__click" {
		t.Fatalf("evidence asked for %v", asked)
	}
	requester.answer(t, id, `{"decision":"allow","message":""}`)
	<-verdict
}

func TestReviewerDeniesSystemPrivacyUICommands(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester}
	for _, command := range []string{
		"tccutil reset ScreenCapture",
		"/usr/bin/tccutil reset All com.linger.desktop",
		`osascript -e 'tell application "System Settings" to activate'`,
		"osascript <<'EOF'\ntell application \"System Preferences\"\nreveal anchor \"Privacy_ScreenCapture\" of pane id \"com.apple.preference.security\"\nend tell\nEOF",
	} {
		verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "Bash", Command: command}})
		if verdict.Decision != Deny || verdict.Message != SystemPrivacyUIMessage {
			t.Fatalf("%q: %+v", command, verdict)
		}
	}
	for _, command := range []string{"screencapture -x shot.png", `osascript -e 'tell application "Finder" to activate'`, "ls tccutil_notes"} {
		if SystemPrivacyUI(command) {
			t.Fatalf("%q was refused", command)
		}
	}
	if len(requester.requests) != 0 {
		t.Fatal("a protected command reached the review")
	}
}
