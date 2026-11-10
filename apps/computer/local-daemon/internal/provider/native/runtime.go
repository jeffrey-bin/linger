// Package native adapts locally installed coding CLIs (Codex, Claude Code,
// Pi) to the Computer Daemon's Operation model.
package native

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// Kinds lists the Runtime kinds this package can open.
var Kinds = []string{"claude", "codex", "pi"}

func Supports(kind string) bool {
	for _, known := range Kinds {
		if kind == known {
			return true
		}
	}
	return false
}

// Open returns the adapter for kind. It performs no I/O.
func Open(kind string, profile Profile) (Runtime, error) {
	if profile.Logger == nil {
		profile.Logger = slog.Default()
	}
	switch kind {
	case "claude":
		return newClaudeRuntime(profile), nil
	case "codex":
		return newCodexRuntime(profile), nil
	case "pi":
		return newPiRuntime(profile), nil
	}
	return nil, fmt.Errorf("native runtime %q is unsupported", kind)
}

// Runtime acquires a provider process for one Operation.
type Runtime interface {
	// Start returns once the Operation is running. An error means nothing
	// runs and nothing must be drained.
	Start(ctx context.Context, prompt string, spec RunSpec) (*Run, error)
}

// Run is one running Operation. Drain Events until closed, then read one
// Outcome; a closed Outcome channel without a value means failure.
type Run struct {
	Events  <-chan Event
	Outcome <-chan Outcome
	// Steer is nil when the provider cannot inject input into a live turn.
	Steer func(context.Context, SteerRequest) (SteerAck, error)
}

// Profile is resolved by trusted Computer composition, never from wire paths.
type Profile struct {
	Program             string
	Env                 map[string]string
	Logger              *slog.Logger
	ToolVersion         string
	CodexToolVersion    string
	ComputerVersion     string
	TaskID              string
	RuntimeID           string
	ContextKey          string
	AgentID             string
	ManagedMCPExtension string
	CodexConfigArgs     []string
	// ResidentSkillDigest identifies the Skills the Daemon delivered to this
	// Operation. A parked process serves only the same digest.
	ResidentSkillDigest string
	// CodexConfigDigest identifies the configuration files the Daemon
	// projected into the Codex home, never what Codex wrote there later.
	CodexConfigDigest string
	// PiConfigDigest identifies the user's Pi settings.json and models.json as
	// the Daemon read them while preparing this Operation.
	PiConfigDigest string
	// RetainProcessTemp is called once per provider process before spawn. The
	// returned release runs only after the process tree is confirmed gone.
	RetainProcessTemp func() (release func() error, err error)
}

type RunSpec struct {
	Dir                   string
	Model                 string
	Budget                time.Duration
	ResumeID              string
	AssignSessionID       string
	ResumeRequired        bool
	PrepareOnly           bool
	WarmMCP               bool
	MCPReady              func(context.Context) error
	Title                 string
	AppendPrompt          string
	BaseInstructions      *string
	DeveloperInstructions *string
	ComputerArgs          []string
	AgentArgs             []string
	MCPServers            json.RawMessage
	Effort                string
	HumanInteraction      *HumanInteractionBridge
	PermissionReviewer    *permission.Reviewer
	CodexPermissionHook   *permission.CodexHook
	RuntimeHome           string
	SharedTaskLink        permission.CodexTaskLink
	ClaudePolicy          *ClaudeToolPolicy
	// ContextWindow is the model's context length in tokens; zero when
	// unknown.
	ContextWindow int
	// Readiness counts the spawns, sessions and recycles of this Operation.
	Readiness           *ReadinessCounters
	ExposeTurnStarted   bool
	StartupBudget       time.Duration
	FirstProgressBudget time.Duration
	SilenceBudget       time.Duration
}

// providerPrepare reports a provider prepare: a run.start without input
// that parks its process for the Context's next Run to adopt.
func (s RunSpec) providerPrepare() bool { return s.PrepareOnly && !s.WarmMCP }

type SteerRequest struct {
	ExpectedTurnID string
	Input          string
}

type SteerAck struct {
	TurnID string
}

// SteerError is a structured refusal of input. Effect "definitely_not_applied"
// is safe to retry; "uncertain" is not.
type SteerError struct {
	Effect         string
	Reason         string
	ExpectedTurnID string
	ActualTurnID   string
	Message        string
}

func (e *SteerError) Error() string { return e.Message }

type NativeResumeMeasurement struct {
	DurationMs int64  `json:"duration_ms"`
	Result     string `json:"result"`
}

// TokenCount: Input excludes cache reads and writes; Reasoning is part of Output.
type TokenCount struct {
	Input      int64
	Output     int64
	CacheRead  int64
	CacheWrite int64
	Reasoning  int64
}

type Outcome struct {
	Parked      bool
	Status      string
	Output      string
	Error       string
	SessionID   string
	TurnID      string
	ElapsedMs   int64
	Diagnostics RuntimeFailureDiagnostics
	// FailureCode is a public failure code set only from a runtime-specific
	// structured signal; empty leaves classification to Diagnostics.
	FailureCode     string
	Usage           map[string]TokenCount
	LastUsage       map[string]TokenCount
	CompactionCount *int64
	NativeResume    *NativeResumeMeasurement
	ExitConfirmed   bool
	ExitUnconfirmed bool
	ResumeRefused   bool

	// retrySafe is Codex-internal: the attempt may be retried once.
	retrySafe bool
}

// Outcome statuses.
const (
	statusCompleted = "completed"
	statusFailed    = "failed"
	statusAborted   = "aborted"
	statusTimeout   = "timeout"
)
