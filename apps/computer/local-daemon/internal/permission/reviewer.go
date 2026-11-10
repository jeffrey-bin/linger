package permission

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"
)

// Requester carries one review to Agent Service and back. The Daemon's
// HumanInteractionBridge implements it: Request emits the review as a
// human_interaction.requested event, and Agent Service answers with a
// runtime_response that reaches respond.
type Requester interface {
	Request(id string, request map[string]any, respond func(json.RawMessage) error) error
	Forget(id string)
}

// DefaultTimeout leaves time for TeamHub's human fallback and Agent Service's
// reply while bounding each tool's wait for a permission decision.
const DefaultTimeout = 20 * time.Second

// Reviewer judges the calls a Runtime adapter hands it. One Reviewer serves
// one Run, so the navigation verdicts it reuses never outlive the Run.
type Reviewer struct {
	Requester   Requester
	Timeout     time.Duration
	Environment Environment
	// TeamHubCommands are the TeamHub CLI commands that run without review.
	TeamHubCommands []TeamHubCommand
	// LocalEvidence collects the page or window a browser or desktop action
	// targets, or returns nil. It is nil when the Run has no local tools.
	LocalEvidence func(ctx context.Context, tool, input string) *Evidence
	// LocalAllowed reports whether a browser or desktop call follows from
	// what the Agent has seen, such as following a link of its page, and
	// runs without review. It is nil when the Run has no local tools.
	LocalAllowed func(tool, input string) bool
	// Now is the clock of verdict reuse; nil means time.Now.
	Now func() time.Time
	// ScriptScope is the ScriptScope of the Run's Agent and Context; a Skill
	// script run_script allows runs only in that scope.
	ScriptScope string

	mu sync.Mutex
	// reuse holds the desktop navigation shapes (GUIReuseKey) the judge
	// allowed, by expiry.
	reuse map[string]time.Time
}

// Review allows the Daemon's own read-only tools, local calls that follow
// what the Agent has seen, the read-only and TeamHub commands the Runtime
// rules could not match, and a desktop navigation step whose shape the judge
// allowed earlier in this Run, and asks the permission review for
// everything else. Every failure answers Unavailable: the Runtime must not
// run a call nobody judged.
func (r *Reviewer) Review(ctx context.Context, request Request) Verdict {
	if ReadOnlyLocalTool(request.Action.Tool, request.Action.Input) ||
		r.LocalAllowed != nil && r.LocalAllowed(request.Action.Tool, request.Action.Input) {
		return Verdict{Decision: Allow}
	}
	if request.Action.Tool == "Bash" && SystemPrivacyUI(request.Action.Command) {
		return Verdict{Decision: Deny, Message: SystemPrivacyUIMessage}
	}
	if request.Action.Tool == "Bash" {
		// Claude runs commands in its workspace; Codex may run one in any
		// workdir its hook does not report.
		cwd := r.Environment.Workspace
		if request.Action.Runtime == "codex" {
			cwd = ""
		}
		switch decision, confirm := Shell(request.Action.Command, cwd, r.Environment.Workspace, r.TeamHubCommands); decision {
		case ShellAllow:
			return Verdict{Decision: Allow}
		case ShellRunAlone:
			return Verdict{Decision: Deny, Message: RunAloneMessage(confirm)}
		}
	}
	reuseKey, reusable := GUIReuseKey(request.Action.Tool, request.Action.Input)
	if reusable && r.reused(reuseKey) {
		return Verdict{Decision: Allow}
	}
	if r.LocalEvidence != nil && request.Evidence == nil && LocalWriteTool(request.Action.Tool, request.Action.Input) {
		request.Evidence = r.LocalEvidence(ctx, request.Action.Tool, request.Action.Input)
	}
	request.Environment = r.Environment
	encoded, err := json.Marshal(request)
	if err != nil {
		return unavailable()
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return unavailable()
	}
	payload["kind"] = "permission_review"
	id, err := reviewID()
	if err != nil {
		return unavailable()
	}
	answered := make(chan Verdict, 1)
	if err := r.Requester.Request(id, payload, func(raw json.RawMessage) error {
		var verdict Verdict
		if json.Unmarshal(raw, &verdict) != nil || !known(verdict.Decision) {
			verdict = unavailable()
		}
		select {
		case answered <- verdict:
		default:
		}
		return nil
	}); err != nil {
		return unavailable()
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case verdict := <-answered:
		if verdict.Decision != Allow && verdict.Message == "" {
			verdict.Message = UnavailableMessage
		}
		if reusable {
			r.remember(reuseKey, verdict.Decision)
		}
		if verdict.Decision == Allow {
			recordApprovedScript(r.ScriptScope, request, r.now())
		}
		return verdict
	case <-ctx.Done():
	case <-timer.C:
	}
	r.Requester.Forget(id)
	return unavailable()
}

func (r *Reviewer) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// reused reports whether the judge allowed this navigation shape within the
// reuse window.
func (r *Reviewer) reused(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	expiry, ok := r.reuse[key]
	if !ok {
		return false
	}
	if !r.now().Before(expiry) {
		delete(r.reuse, key)
		return false
	}
	return true
}

// remember keeps an allow for its shape and drops the shape on any other
// verdict: a denial or an approval card means the judge wants to see the
// next call of that shape too.
func (r *Reviewer) remember(key string, decision Decision) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if decision != Allow {
		delete(r.reuse, key)
		return
	}
	if r.reuse == nil {
		r.reuse = map[string]time.Time{}
	}
	r.reuse[key] = r.now().Add(guiReuseTTL)
}

func known(decision Decision) bool {
	switch decision {
	case Allow, NeedsApproval, Deny, Unavailable:
		return true
	}
	return false
}

func reviewID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "permission-" + hex.EncodeToString(raw[:]), nil
}
