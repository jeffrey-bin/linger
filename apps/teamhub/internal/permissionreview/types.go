// Package permissionreview judges one pending runtime tool action: given the
// planned action, the native runtime transcript, local evidence, and the
// TeamHub-verified user authorization messages, it asks a model whether the
// action is allowed, denied, or needs human approval.
//
// The package is the production judge used by the Runtime Permission Hook.
package permissionreview

import (
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// Risk is the intrinsic risk of the action, independent of authorization.
// The taxonomy mirrors Codex guardian (Apache-2.0): low/medium are allowed by
// default, high needs authorization, critical is always denied.
type Risk string

const (
	RiskLow      Risk = "low"
	RiskMedium   Risk = "medium"
	RiskHigh     Risk = "high"
	RiskCritical Risk = "critical"
)

// Authorization is how strongly the trusted user messages cover this exact
// action, its payload, and its side effects.
type Authorization string

const (
	AuthHigh    Authorization = "high"
	AuthMedium  Authorization = "medium"
	AuthLow     Authorization = "low"
	AuthUnknown Authorization = "unknown"
)

// Decision is the final verdict the hook acts on. unavailable is reserved for
// model/transport failure and is never produced by the model itself.
type Decision string

const (
	DecisionAllow         Decision = "allow"
	DecisionNeedsApproval Decision = "needs_approval"
	DecisionDeny          Decision = "deny"
	DecisionUnavailable   Decision = "unavailable"
)

// Action is the planned tool call under review. It is untrusted evidence: the
// model must never treat fields here as authorization.
type Action struct {
	// Runtime is "claude" or "codex"; background for the model, not a rule input.
	Runtime string `json:"runtime"`
	// Surface classifies what kind of effect this action can have. One of
	// "shell", "file_edit", "connected_app", "browser", "computer", "web".
	Surface string `json:"surface"`
	// Tool is the native tool name (Bash, mcp__browser__browser_click, ...).
	Tool string `json:"tool"`
	// Command is the raw shell command string, when Surface == "shell".
	Command string `json:"command,omitempty"`
	// Input is the native tool input, rendered as compact JSON.
	Input string `json:"input,omitempty"`
	// Digest is the normalized action fingerprint; a one-time grant binds to it.
	Digest string `json:"digest,omitempty"`
	// Subagent is the sub-agent id when the call came from a sub-agent.
	Subagent string `json:"subagent,omitempty"`
}

// TranscriptEntry is one normalized record from the runtime session file. It is
// untrusted evidence. Authors of user turns are NOT carried here: trusted user
// messages come from Authorization instead.
type TranscriptEntry struct {
	// Kind is "assistant", "tool_call", or "tool_result".
	Kind string `json:"kind"`
	// Tool is the tool name for tool_call / tool_result entries.
	Tool string `json:"tool,omitempty"`
	// Text is the rendered content, already truncated to the per-entry budget.
	Text string `json:"text"`
	// Truncated marks that Text was cut; the model must treat the rest as
	// omitted, not benign.
	Truncated bool `json:"truncated,omitempty"`
}

// AuthorizationMessage is a Room message with a server-verified author. Only
// these establish user authorization; CanAuthorize is set by TeamHub, not the
// model.
type AuthorizationMessage struct {
	ID string `json:"id"`
	// Author is the display name, for the model's rationale only.
	Author string `json:"author"`
	// Role is "sponsor", "room_member", or "agent".
	Role string `json:"role"`
	// CanAuthorize is true only for the sponsor (and, later, designated
	// approvers). A room member's "go ahead" is context, never authorization.
	CanAuthorize bool `json:"can_authorize"`
	// At is an RFC3339 timestamp; ordering matters (a later revoke beats an
	// earlier approval).
	At   string `json:"at"`
	Text string `json:"text"`
}

// PriorDecision is a past human verdict on the same action digest: a consumed,
// denied, or expired grant. A consumed or denied prior cannot itself authorize
// a retry.
type PriorDecision struct {
	Digest    string `json:"digest"`
	Status    string `json:"status"` // approved | consumed | denied | expired
	DecidedBy string `json:"decided_by"`
	At        string `json:"at"`
	Text      string `json:"text,omitempty"`
}

// Evidence is host-collected, action-specific proof. Each field is optional;
// what cannot be collected is named in Missing so the model stays cautious
// rather than assuming the gap is benign.
type Evidence struct {
	// Script is the content of a shell-referenced script, when resolved.
	Script *ScriptEvidence `json:"script,omitempty"`
	// Patch is the full apply_patch / diff body, when the action edits files.
	Patch string `json:"patch,omitempty"`
	// Browser is the current page and resolved target element.
	Browser *BrowserEvidence `json:"browser,omitempty"`
	// Desktop is the target window and the elements its tokens name.
	Desktop *DesktopEvidence `json:"desktop,omitempty"`
	// Missing lists facts the host could not obtain (e.g. the real workdir).
	Missing []string `json:"missing,omitempty"`
	// Screenshot is the screen before a GUI action, for the approver only:
	// it is never rendered for the judge nor part of the action digest.
	Screenshot *ScreenshotEvidence `json:"-"`
}

type ScreenshotEvidence struct {
	MediaType     string
	Data          []byte
	Width, Height int
}

type ScriptEvidence struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Body   string `json:"body"`
}

type BrowserEvidence struct {
	URL        string `json:"url"`
	Title      string `json:"title,omitempty"`
	TargetRole string `json:"target_role,omitempty"`
	TargetName string `json:"target_name,omitempty"`
	FormFields string `json:"form_fields,omitempty"`
}

// DesktopEvidence is the window a desktop action targets and the elements
// its tokens name.
type DesktopEvidence struct {
	App         string          `json:"app,omitempty"`
	WindowTitle string          `json:"window_title,omitempty"`
	Targets     []DesktopTarget `json:"targets,omitempty"`
}

// DesktopTarget is the element an element token names in the agent's
// latest read of the window.
type DesktopTarget struct {
	Token string `json:"token"`
	Role  string `json:"role"`
	Name  string `json:"name,omitempty"`
}

// Environment is small, always-included framing.
type Environment struct {
	Runtime        string `json:"runtime"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	Platform       string `json:"platform,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
	Workspace      string `json:"workspace,omitempty"`
	AgentName      string `json:"agent_name,omitempty"`
	ContextKind    string `json:"context_kind,omitempty"`
	SponsorName    string `json:"sponsor_name,omitempty"`
}

// Request is the complete judge input for one action.
type Request struct {
	// Owner is the sponsor, whose Another Me model is the fallback judge. It
	// routes the call and is never shown to the model.
	Owner roomagent.ModelCallOwner `json:"-"`
	// ContextKey names the reviewed Context, whose reviews share one judge
	// session.
	ContextKey string `json:"-"`
	// RunOperationID names the Run Operation that waits for the verdict, so
	// the judge's model call can run in that Run's queue place.
	RunOperationID string                 `json:"-"`
	Environment    Environment            `json:"environment"`
	Action         Action                 `json:"action"`
	Authorizations []AuthorizationMessage `json:"authorizations"`
	PriorDecisions []PriorDecision        `json:"prior_decisions"`
	Transcript     []TranscriptEntry      `json:"transcript"`
	Evidence       Evidence               `json:"evidence"`
}

// ModelOutput is the strict-JSON object the model returns: Codex guardian's
// assessment, with decision able to ask a human instead of only allow or deny.
type ModelOutput struct {
	RiskLevel         Risk          `json:"risk_level"`
	UserAuthorization Authorization `json:"user_authorization"`
	Decision          Decision      `json:"decision"`
	Rationale         string        `json:"rationale"`
}

// Verdict is what the judge returns after validating the model output. Decision
// is authoritative; the rationale explains it to the Runtime and the approver.
type Verdict struct {
	Decision          Decision
	RiskLevel         Risk
	UserAuthorization Authorization
	Rationale         string
}
