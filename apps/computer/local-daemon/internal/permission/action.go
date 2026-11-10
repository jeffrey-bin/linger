// Package permission is the Runtime-independent part of the Runtime tool
// permission hook. A Runtime adapter turns the call its Runtime would otherwise
// ask a human about into a Request; the Reviewer allows the Daemon's own
// read-only tools and sends everything else to the permission review TeamHub
// runs, through Agent Service, and returns the verdict the adapter encodes.
package permission

import "strings"

// Request is one pending tool call in the shape of TeamHub's permission
// review request (context, Run, and request ids are added by Agent Service).
type Request struct {
	Action      Action            `json:"action"`
	Environment Environment       `json:"environment,omitzero"`
	Transcript  []TranscriptEntry `json:"transcript,omitempty"`
	Evidence    *Evidence         `json:"evidence,omitempty"`
}

type Action struct {
	Runtime  string `json:"runtime"`
	Surface  string `json:"surface"`
	Tool     string `json:"tool"`
	Command  string `json:"command,omitempty"`
	Input    string `json:"input,omitempty"`
	Subagent string `json:"subagent,omitempty"`
}

type Environment struct {
	RuntimeVersion string `json:"runtime_version,omitempty"`
	Platform       string `json:"platform,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
	Workspace      string `json:"workspace,omitempty"`
}

// TranscriptEntry is one recent assistant message or tool call/result from
// the Runtime session file. Runtime user turns are never included: TeamHub
// supplies the trusted user messages itself.
type TranscriptEntry struct {
	Kind      string `json:"kind"`
	Tool      string `json:"tool,omitempty"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

type Evidence struct {
	Script  *Script  `json:"script,omitempty"`
	Patch   string   `json:"patch,omitempty"`
	Browser *Browser `json:"browser,omitempty"`
	Desktop *Desktop `json:"desktop,omitempty"`
	Missing []string `json:"missing,omitempty"`
	// Screenshot is shown only to the approver; the judge never sees it.
	Screenshot *Screenshot `json:"screenshot,omitempty"`
}

// Browser is the page a browser action acts on and its target element, as
// the page snapshot the Agent planned on names them.
type Browser struct {
	URL        string `json:"url"`
	Title      string `json:"title,omitempty"`
	TargetRole string `json:"target_role,omitempty"`
	TargetName string `json:"target_name,omitempty"`
	FormFields string `json:"form_fields,omitempty"`
}

// Desktop is the window a desktop action acts on and the elements its
// element tokens name in the Agent's latest read of that window.
type Desktop struct {
	App         string          `json:"app,omitempty"`
	WindowTitle string          `json:"window_title,omitempty"`
	Targets     []DesktopTarget `json:"targets,omitempty"`
}

// DesktopTarget is the element one element token names.
type DesktopTarget struct {
	Token string `json:"token"`
	Role  string `json:"role"`
	Name  string `json:"name,omitempty"`
}

// Screenshot is base64 image bytes of the screen or page before the action.
type Screenshot struct {
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

type Script struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Body   string `json:"body"`
}

type Decision string

const (
	Allow         Decision = "allow"
	NeedsApproval Decision = "needs_approval"
	Deny          Decision = "deny"
	Unavailable   Decision = "unavailable"
)

// Verdict is what the adapter tells the Runtime. Message is shown to the
// Runtime model whenever the call does not run.
type Verdict struct {
	Decision      Decision `json:"decision"`
	Message       string   `json:"message"`
	InteractionID string   `json:"interaction_id,omitempty"`
}

// UnavailableMessage matches TeamHub's wording for a review that could not run.
// Keep it byte-identical with TeamHub permissionreview unavailableMessage and the
// node-services PERMISSION_REVIEW_UNAVAILABLE copy; the tool-approval protocol quotes it.
const UnavailableMessage = "The permission review service is temporarily unavailable, so this operation did not run. Retry later; do not reach the same effect another way."

func unavailable() Verdict {
	return Verdict{Decision: Unavailable, Message: UnavailableMessage}
}

// Surface classifies a tool for the judge. It is context for the model, not a
// rule input.
func Surface(tool, command string) string {
	switch {
	case strings.HasPrefix(tool, "mcp__browser__"):
		return "browser"
	case strings.HasPrefix(tool, "mcp__computer__"):
		return "computer"
	case strings.HasPrefix(tool, "mcp__"):
		return "other"
	case tool == "Edit" || tool == "Write" || tool == "NotebookEdit" || tool == "apply_patch":
		return "file_edit"
	case tool == "WebFetch" || tool == "WebSearch":
		return "web"
	case tool == "Bash" && strings.HasPrefix(strings.TrimSpace(command), "teamhub "):
		return "connected_app"
	case tool == "Bash":
		return "shell"
	}
	return "other"
}
