package provider

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

const operationMCPPrepareKind = "internal.mcp.prepare"

// operationProviderPrepareKind is a run.start without input: it parks the
// Provider process the Context's next Run adopts.
const operationProviderPrepareKind = "internal.provider.prepare"

type OperationSpec struct {
	HumanInteractions bool
	// PermissionReview sends the Runtime's own permission prompts to the
	// Runtime permission review (Agent Service declares it per Run).
	PermissionReview bool
	// TeamHubCLIBin is the bundled TeamHub CLI directory; its command manifest
	// names the TeamHub commands that run without review.
	TeamHubCLIBin        string
	PrepareNativeResume  *native.NativeResumeMeasurement
	OperationKind        string
	Provider             string
	ExecutablePath       string
	WorkingDirectory     string
	Model                string
	Prompt               string
	ResumeSessionID      string
	Timeout              time.Duration
	Environment          map[string]string
	ExtraArgs            []string
	CustomArgs           []string
	MCPConfig            json.RawMessage
	MCPRelays            json.RawMessage
	MCPReady             func(context.Context) error
	TrustedLocalMCPTools []string
	// LocalEvidence describes the target of a local browser or desktop
	// call for the permission review.
	LocalEvidence func(ctx context.Context, tool, input string) *permission.Evidence
	// LocalAllowed reports whether a local browser or desktop call runs
	// without review.
	LocalAllowed     func(tool, input string) bool
	ClaudeSkillNames []string
	// ContextSkillDigest identifies the Skill packages of the Context View
	// the Daemon published into the workspace.
	ContextSkillDigest      string
	CreateProviderSessionID string
	ThinkingLevel           string
	ThreadName              string
	SystemPrompt            string
	BaseInstructions        *string
	DeveloperInstructions   *string
	TaskID                  string
	ExecutionRunRef         string
	RegistrationID          string
	DaemonVersion           string
	CodexVersion            string
	TenantID                string
	OwnerActorID            string
	AgentID                 string
	ComputerID              string
	ScopeID                 string
	// ContextWindow is the selected model's context length in tokens as
	// Runtime discovery resolved it; zero when unknown.
	ContextWindow int
	// SharedTask names the real shared Task directories the Context's
	// managed links reach; the Runtime is granted exactly these.
	SharedTask SharedTaskAccess
}

// SharedTaskAccess is a Context's shared Task access. An alter_ego writes its
// own Task directory; a Meta reads its Room tasks directory. Neither grants
// the shared root.
type SharedTaskAccess struct {
	WritableTaskRoot string
	// WritableTaskLink is the workspace-relative link to WritableTaskRoot.
	WritableTaskLink  string
	ReadableTasksRoot string
}

type EmitFunc func(context.Context, protocol.Event) error

type BackendFactory func(string, native.Profile) (native.Runtime, error)

type Executor struct {
	NewBackend      BackendFactory
	Logger          *slog.Logger
	TempBase        string
	RuntimeHomeRoot string
	// CodexModelSessionHome is the model session's Codex home, one more source
	// of a models cache for a Context's new home.
	CodexModelSessionHome string
	PiMCPExtension        string
}

type Result struct {
	Diagnostics        native.RuntimeFailureDiagnostics
	FailureCode        string
	NativeResume       *native.NativeResumeMeasurement
	LastUsage          map[string]native.TokenCount
	CompactionCount    *int64
	CleanupConfirmed   bool
	CleanupUnconfirmed bool
	Status             string
	Output             string
	Error              string
	SessionID          string
	Usage              map[string]native.TokenCount
	TurnID             string
	// PreparedParked reports whether a Provider prepare left its process parked.
	PreparedParked bool
}

type Execution struct {
	interactions *native.HumanInteractionBridge
	Result       <-chan Result
	ready        chan struct{}
	mu           sync.Mutex
	inputMu      sync.Mutex
	session      *native.Run
	done         bool
}

type SteerError struct {
	Effect       string
	Reason       string
	ActualTurnID string
	Message      string
}

// PrepareProvider is the run.start of spec without input: it parks a Codex
// or Claude process for the spec's session without submitting a turn. The
// Run's attachments, its MCP servers and prompt, are connected when the Run
// adopts the process, so a prepare carries none. A compatible resident is
// left parked as it is.
func (e Executor) PrepareProvider(ctx context.Context, spec OperationSpec) (Result, error) {
	if spec.Provider != "codex" && spec.Provider != "claude" {
		return Result{}, errors.New("provider prepare is supported only for Codex and Claude")
	}
	spec.OperationKind = operationProviderPrepareKind
	spec.Prompt = ""
	spec.MCPConfig = nil
	spec.MCPReady = nil
	spec.TrustedLocalMCPTools = nil
	spec.LocalEvidence = nil
	spec.LocalAllowed = nil
	execution, err := e.Start(ctx, spec, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		return Result{}, err
	}
	result, ok := <-execution.Result
	if !ok {
		return Result{}, errors.New("provider prepare closed without a result")
	}
	if result.CleanupUnconfirmed {
		return result, errors.Join(ErrPreparationCleanupUnconfirmed, errors.New(result.Error), context.Cause(ctx))
	}
	if result.Status != "completed" {
		if result.Error == "" {
			result.Error = "provider prepare did not complete"
		}
		return result, errors.Join(errors.New(result.Error), context.Cause(ctx))
	}
	return result, nil
}

func (e *Execution) Respond(ctx context.Context, id string, payload json.RawMessage) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	bridge, done := e.interactions, e.done
	e.mu.Unlock()
	if bridge == nil || done {
		return &native.SteerError{Effect: "definitely_not_applied", Reason: "no_active_turn", Message: "Runtime interaction is no longer pending"}
	}
	return bridge.Respond(id, payload)
}

func (e *SteerError) Error() string { return e.Message }

var ErrPreparationCleanupUnconfirmed = errors.New("MCP preparation cleanup is unconfirmed")

// PrepareMCP materializes the same Codex runtime home and exact MCP config a
// run.start will use, then parks the bound app-server only after its MCP
// initialize/initialized/tools-list handshake is complete. No model turn is
// submitted and no Operation event is persisted.
func (e Executor) PrepareMCP(ctx context.Context, spec OperationSpec) (Result, error) {
	if spec.Provider != "codex" {
		return Result{}, errors.New("MCP preparation is supported only for Codex")
	}
	spec.OperationKind = operationMCPPrepareKind
	spec.Prompt = ""
	execution, err := e.Start(ctx, spec, func(context.Context, protocol.Event) error { return nil })
	if err != nil {
		return Result{}, err
	}
	result, ok := <-execution.Result
	if !ok {
		return Result{}, errors.New("Codex MCP preparation closed without a result")
	}
	if result.CleanupUnconfirmed {
		return result, errors.Join(ErrPreparationCleanupUnconfirmed, errors.New(result.Error), context.Cause(ctx))
	}
	if result.Status != "completed" {
		if result.Error == "" {
			result.Error = "Codex MCP preparation did not complete"
		}
		return result, errors.Join(errors.New(result.Error), context.Cause(ctx))
	}
	return result, nil
}

func (e *Execution) Input(ctx context.Context, request native.SteerRequest) (native.SteerAck, error) {
	e.inputMu.Lock()
	defer e.inputMu.Unlock()
	select {
	case <-ctx.Done():
		return native.SteerAck{}, ctx.Err()
	case <-e.ready:
	}
	e.mu.Lock()
	session, done := e.session, e.done
	e.mu.Unlock()
	if done || session == nil || session.Steer == nil {
		return native.SteerAck{}, &SteerError{
			Effect: "definitely_not_applied", Reason: "no_active_turn",
			Message: "Provider has no active turn to steer",
		}
	}
	ack, err := session.Steer(ctx, request)
	if err == nil {
		return ack, nil
	}
	var providerErr *native.SteerError
	if errors.As(err, &providerErr) {
		return native.SteerAck{}, &SteerError{
			Effect: providerErr.Effect, Reason: providerErr.Reason,
			ActualTurnID: providerErr.ActualTurnID, Message: providerErr.Message,
		}
	}
	return native.SteerAck{}, err
}

func (e Executor) Start(ctx context.Context, spec OperationSpec, emit EmitFunc) (*Execution, error) {
	if emit == nil {
		return nil, errors.New("provider executor requires an event emitter")
	}
	if spec.Provider == "" || spec.ExecutablePath == "" {
		return nil, errors.New("provider and executable path are required")
	}
	if spec.WorkingDirectory == "" {
		return nil, errors.New("working directory is required")
	}
	newBackend := e.NewBackend
	logger := e.Logger
	if logger == nil {
		logger = slog.Default()
	}
	// An MCP or provider prepare resolves the authorization of the reviewed run
	// it precedes, so its Claude argv and Codex hook match that run's.
	authorization := spec
	if spec.OperationKind == operationMCPPrepareKind || spec.OperationKind == operationProviderPrepareKind {
		authorization.OperationKind = "run.start"
	}
	var teamhubCommands []permission.TeamHubCommand
	if authorization.ReviewsPermissions() {
		// An unreadable manifest allows no TeamHub command: each is judged.
		var err error
		if teamhubCommands, err = permission.TeamHubAllowedCommands(spec.TeamHubCLIBin); err != nil {
			logger.Warn("runner.teamhub_command_manifest.unavailable", "operation_kind", spec.OperationKind, "cli_directory", spec.TeamHubCLIBin, "error", err)
		}
	}
	var claudePolicy *native.ClaudeToolPolicy
	if spec.Provider == "claude" {
		claudePolicy = &native.ClaudeToolPolicy{Workspace: spec.WorkingDirectory, SkillNames: append([]string{}, spec.ClaudeSkillNames...)}
		claudePolicy.MCPToolNames = append([]string(nil), spec.TrustedLocalMCPTools...)
		if authorization.ReviewsPermissions() {
			claudePolicy.ReviewPermissions = true
			claudePolicy.AllowRules = permission.ClaudeAllowRules(teamhubCommands)
			claudePolicy.AllowRules = append(claudePolicy.AllowRules, permission.ClaudeSharedTaskRules(spec.SharedTask.WritableTaskRoot, spec.SharedTask.ReadableTasksRoot)...)
		}
		var relays []struct {
			Name      string   `json:"name"`
			ToolNames []string `json:"tool_names"`
		}
		if len(spec.MCPRelays) > 0 {
			if err := json.Unmarshal(spec.MCPRelays, &relays); err != nil {
				return nil, errors.New("Claude MCP authorization descriptors are invalid")
			}
		}
		for _, relay := range relays {
			for _, tool := range relay.ToolNames {
				claudePolicy.MCPToolNames = append(claudePolicy.MCPToolNames, "mcp__"+relay.Name+"__"+tool)
			}
		}
	}
	if newBackend == nil {
		newBackend = native.Open
	}
	environment := cloneEnvironment(spec.Environment)

	var operationTemp *localworkspace.OperationTemp
	if e.TempBase != "" {
		var err error
		operationTemp, err = localworkspace.PrepareOperationTemp(e.TempBase)
		if err != nil {
			return nil, err
		}
		if environment == nil {
			environment = make(map[string]string)
		}
		for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
			environment[key] = operationTemp.Path
		}
	}
	var runtimeHome *localworkspace.RuntimeHome
	if e.RuntimeHomeRoot != "" && spec.Provider == "codex" {
		sharedHome, err := localworkspace.CodexSourceHome(environment)
		if err != nil {
			if operationTemp != nil {
				_ = operationTemp.Close()
			}
			return nil, err
		}
		runtimeHome, err = localworkspace.PrepareCodexRuntimeHome(ctx, e.RuntimeHomeRoot, sharedHome, localworkspace.RuntimeHomeIdentity{
			TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID, AgentID: spec.AgentID,
			ScopeID: spec.ScopeID, ProviderType: spec.Provider,
		}, spec.CodexVersion, logger, environment["HOME"], e.CodexModelSessionHome)
		if err != nil {
			if operationTemp != nil {
				_ = operationTemp.Close()
			}
			return nil, err
		}
		if environment == nil {
			environment = make(map[string]string)
		}
		environment["CODEX_HOME"] = runtimeHome.Path
	}

	if e.RuntimeHomeRoot != "" && spec.Provider == "claude" {
		claudeHome, claudeErr := localworkspace.PrepareClaudeRuntimeHome(ctx, e.RuntimeHomeRoot, localworkspace.RuntimeHomeIdentity{
			TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID, AgentID: spec.AgentID,
			ScopeID: spec.ScopeID, ProviderType: spec.Provider,
		})
		if claudeErr != nil {
			if operationTemp != nil {
				_ = operationTemp.Close()
			}
			return nil, claudeErr
		}
		runtimeHome = claudeHome
		if environment == nil {
			environment = make(map[string]string)
		}
		environment["LINGER_CLAUDE_SESSION_ROOT"] = filepath.Join(runtimeHome.Path, "sessions")
	}
	var piConfigDigest string
	if spec.Provider == "pi" {
		var err error
		environment, err = localworkspace.PiSourceEnvironment(environment)
		if err == nil {
			piConfigDigest, err = localworkspace.PiConfigDigest(environment)
		}
		if err == nil {
			runtimeHome, err = localworkspace.PreparePiRuntimeHome(ctx, e.RuntimeHomeRoot, localworkspace.RuntimeHomeIdentity{
				TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID, AgentID: spec.AgentID,
				ScopeID: spec.ScopeID, ProviderType: spec.Provider,
			})
		}
		if err != nil {
			if operationTemp != nil {
				_ = operationTemp.Close()
			}
			return nil, err
		}
		environment["LINGER_PI_SESSION_ROOT"] = filepath.Join(runtimeHome.Path, "sessions")
	}
	var codexConfigArgs []string
	var codexConfigDigest string
	// A resident process serves only the Skills the Daemon delivered to it.
	residentSkillDigest := spec.ContextSkillDigest
	var codexHook *permission.CodexHook
	mcpConfig := append(json.RawMessage(nil), spec.MCPConfig...)
	if runtimeHome != nil {
		var capabilityErr error
		switch spec.Provider {
		case "codex":
			codexConfigArgs = slices.Clone(runtimeHome.ConfigArgs)
			codexConfigArgs = append(codexConfigArgs, localworkspace.CodexContextCLIArgs(environment)...)
			codexConfigDigest = runtimeHome.ConfigDigest
			skills := sha256.Sum256([]byte(runtimeHome.SkillDigest + "\x00" + spec.ContextSkillDigest))
			residentSkillDigest = hex.EncodeToString(skills[:])
			if native.CodexSupportsDirectTools(spec.CodexVersion) {
				mcpConfig, capabilityErr = codexDirectLocalTools(mcpConfig, spec.TrustedLocalMCPTools)
			}
			// A prepare binds the thread its reviewed Run reuses, so it carries the
			// same hook as that Run; the binding fingerprint covers the hook. The
			// Run's MCP servers are attached when it adopts the process.
			if capabilityErr == nil && authorization.ReviewsPermissions() && native.CodexSupportsPermissionHook(spec.CodexVersion) {
				codexHook, mcpConfig, capabilityErr = prepareCodexPermissionReview(runtimeHome.Path, teamhubCommands, mcpConfig)
			}

		case "claude":
			var inherited []string
			inherited, capabilityErr = localworkspace.ConfigureClaudeContextHome(runtimeHome.Path, spec.WorkingDirectory, environment, func() error {
				return retireClaudeResident(runtimeHome.Path)
			})
			// The Skill tool is authorized by name. Inherited Skills are
			// discovered here, after the Context's authorized Snapshot has
			// already filled the policy, so they are added from the projection
			// that actually created them rather than discovered twice.
			if capabilityErr == nil && claudePolicy != nil {
				claudePolicy.SkillNames = append(claudePolicy.SkillNames, inherited...)
			}
		}
		if capabilityErr != nil {
			_ = runtimeHome.Close()
			if operationTemp != nil {
				_ = operationTemp.Close()
			}
			return nil, capabilityErr
		}
	}
	if runtimeHome != nil {
		logger = localDiagnosticLogger(runtimeHome.Path, spec, environment)
	}
	logger.Info("runtime.operation.start", "operation_id", spec.TaskID, "kind", spec.OperationKind)
	var retainProcessTemp func() (func() error, error)
	if operationTemp != nil {
		retainProcessTemp = operationTemp.Retain
	}
	backend, err := newBackend(spec.Provider, native.Profile{
		Program:             spec.ExecutablePath,
		ManagedMCPExtension: e.PiMCPExtension,
		Env:                 environment,
		RetainProcessTemp:   retainProcessTemp,
		ContextKey:          spec.ScopeID,
		AgentID:             spec.AgentID,
		Logger:              logger,
		TaskID:              spec.TaskID,
		RuntimeID:           spec.RegistrationID,
		ComputerVersion:     spec.DaemonVersion,
		CodexToolVersion:    spec.CodexVersion,
		CodexConfigArgs:     codexConfigArgs,
		CodexConfigDigest:   codexConfigDigest,
		PiConfigDigest:      piConfigDigest,
		ResidentSkillDigest: residentSkillDigest,
	})
	if err != nil {
		if runtimeHome != nil {
			_ = runtimeHome.Close()
		}
		if operationTemp != nil {
			_ = operationTemp.Close()
		}
		return nil, fmt.Errorf("create %s provider: %w", spec.Provider, err)
	}
	resultCh := make(chan Result, 1)
	execution := &Execution{Result: resultCh, ready: make(chan struct{})}
	readiness := &native.ReadinessCounters{}
	go func() {
		defer close(resultCh)
		executionCtx, cancelExecution := context.WithCancel(ctx)
		defer cancelExecution()
		finish := func(result Result) {
			logger.Info("runtime.readiness", append([]any{"kind", spec.OperationKind}, readiness.LogAttrs()...)...)
			if result.Error != "" {
				logger.Error("runtime.operation.failed", "error", result.Error)
			} else {
				logger.Info("runtime.operation.finished", "kind", result.Status)
			}
			if runtimeHome != nil {
				_ = runtimeHome.Close()
			}
			if operationTemp != nil {
				if err := operationTemp.Close(); err != nil {
					logger.Warn("Operation temp cleanup failed", "path", operationTemp.Path, "error", err)
				}
			}
			resultCh <- result
		}
		var bridge *native.HumanInteractionBridge
		if (spec.HumanInteractions || spec.PermissionReview) && spec.OperationKind == "run.start" {
			bridge = native.NewHumanInteractionBridge(func(message native.Event) {
				payload, err := json.Marshal(map[string]any{"type": "human_interaction.requested", "request": message.Input})
				if err == nil {
					err = emit(ctx, protocol.Event{Type: protocol.EventOperationEvent, SentAt: time.Now().UTC(), Payload: payload})
				}
				if err != nil {
					cancelExecution()
				}
			})
			execution.mu.Lock()
			execution.interactions = bridge
			execution.mu.Unlock()
			defer bridge.Close()
		}
		// The bridge carries both Room questions and permission reviews, but
		// only a Context with Room questions posts Codex's native questions.
		var questions *native.HumanInteractionBridge
		if spec.HumanInteractions {
			questions = bridge
		}
		var reviewer *permission.Reviewer
		if spec.ReviewsPermissions() {
			reviewer = &permission.Reviewer{Requester: bridge, TeamHubCommands: teamhubCommands, ScriptScope: permission.ScriptScope(spec.AgentID, spec.ScopeID), LocalEvidence: spec.LocalEvidence, LocalAllowed: spec.LocalAllowed, Environment: permission.Environment{
				RuntimeVersion: spec.CodexVersion, Platform: runtime.GOOS, Workspace: spec.WorkingDirectory,
			}}
		}
		runtimeHomePath := ""
		if runtimeHome != nil {
			runtimeHomePath = runtimeHome.Path
		}
		runSpec := native.RunSpec{
			HumanInteraction:      questions,
			PermissionReviewer:    reviewer,
			CodexPermissionHook:   codexHook,
			RuntimeHome:           runtimeHomePath,
			Dir:                   spec.WorkingDirectory,
			SharedTaskLink:        permission.CodexTaskLink{Path: spec.SharedTask.WritableTaskLink, Target: spec.SharedTask.WritableTaskRoot},
			Model:                 spec.Model,
			PrepareOnly:           spec.OperationKind == operationMCPPrepareKind || spec.OperationKind == operationProviderPrepareKind,
			WarmMCP:               spec.OperationKind == operationMCPPrepareKind,
			MCPReady:              spec.MCPReady,
			AssignSessionID:       spec.CreateProviderSessionID,
			ResumeID:              spec.ResumeSessionID,
			ResumeRequired:        spec.ResumeSessionID != "",
			Budget:                spec.Timeout,
			ComputerArgs:          append([]string(nil), spec.ExtraArgs...),
			AgentArgs:             append([]string(nil), spec.CustomArgs...),
			MCPServers:            mcpConfig,
			Effort:                spec.ThinkingLevel,
			ContextWindow:         spec.ContextWindow,
			Title:                 spec.ThreadName,
			AppendPrompt:          spec.SystemPrompt,
			BaseInstructions:      spec.BaseInstructions,
			DeveloperInstructions: spec.DeveloperInstructions,
			ExposeTurnStarted:     spec.OperationKind == "run.start",
			ClaudePolicy:          claudePolicy,
			Readiness:             readiness,
		}
		session, err := backend.Start(executionCtx, spec.Prompt, runSpec)
		if err != nil {
			execution.mu.Lock()
			execution.done = true
			execution.mu.Unlock()
			close(execution.ready)
			finish(Result{Status: "failed", Error: err.Error()})
			return
		}
		execution.mu.Lock()
		execution.session = session
		execution.mu.Unlock()
		close(execution.ready)
		var executionFailure string
		var providerResult native.Outcome
		var ok bool
		freshSession := false
		if spec.OperationKind == "run.start" && spec.Provider != "codex" && spec.Provider != "claude" && spec.Provider != "pi" {
			payload, marshalErr := json.Marshal(map[string]any{
				"type": "run.started", "turn_id": stableEventID("turn", spec.TaskID),
			})
			if marshalErr != nil {
				executionFailure = fmt.Sprintf("marshal synthetic turn: %v", marshalErr)
				cancelExecution()
			} else if emitErr := emit(ctx, protocol.Event{Type: protocol.EventOperationEvent, SentAt: time.Now().UTC(), Payload: payload}); emitErr != nil {
				executionFailure = fmt.Sprintf("emit synthetic turn: %v", emitErr)
				cancelExecution()
			}
		}
		emittedResponseText := false
		projection := eventProjection{operationID: spec.TaskID}
		for {
			emittedEvent := false
			for message := range session.Events {
				if executionFailure != "" {
					continue
				}
				if spec.OperationKind == "run.start" && message.Kind == native.EventStatus && message.Status == "running" && message.TurnID == "" {
					continue
				}
				if message.Kind == native.EventText && (message.Body != "" || message.Output != "") {
					emittedResponseText = true
				}
				for _, projected := range projection.project(message) {
					emittedEvent = true
					payload, marshalErr := json.Marshal(projected)
					if marshalErr != nil {
						executionFailure = fmt.Sprintf("marshal provider event: %v", marshalErr)
						cancelExecution()
						continue
					}
					if emitErr := emit(ctx, protocol.Event{
						Type:    protocol.EventOperationEvent,
						SentAt:  time.Now().UTC(),
						Payload: payload,
					}); emitErr != nil {
						executionFailure = fmt.Sprintf("emit provider event: %v", emitErr)
						cancelExecution()
					}
				}
			}
			providerResult, ok = <-session.Outcome
			if !ok || freshSession || emittedEvent || executionFailure != "" || executionCtx.Err() != nil ||
				!startsFreshSession(spec, providerResult) {
				break
			}
			// The retained session is not in this Computer's runtime home, for
			// example one an earlier Local Computer created elsewhere. Nothing
			// reached the Room yet, so the Run continues in a new session once;
			// its terminal result carries the new identity the server keeps.
			freshSession = true
			runSpec.ResumeID, runSpec.ResumeRequired, runSpec.AssignSessionID = "", false, ""
			if spec.Provider == "claude" || spec.Provider == "pi" {
				runSpec.AssignSessionID = uuid.NewString()
			}
			logger.Warn("runtime.session.fresh_start", "provider", spec.Provider, "reason", providerResult.FailureCode)
			slog.Warn("runner.operation.fresh_session", "operation_id", spec.TaskID, "provider", spec.Provider,
				"agent_id", spec.AgentID, "reason", providerResult.FailureCode)
			if session, err = backend.Start(executionCtx, spec.Prompt, runSpec); err != nil {
				execution.mu.Lock()
				execution.done = true
				execution.mu.Unlock()
				finish(Result{Status: "failed", Error: err.Error()})
				return
			}
			execution.mu.Lock()
			execution.session = session
			execution.mu.Unlock()
		}
		execution.mu.Lock()
		execution.done = true
		execution.mu.Unlock()
		if !ok {
			finish(Result{Status: "failed", Error: "provider result channel closed without a result"})
			return
		}
		if executionFailure != "" {
			finish(Result{Status: "failed", Error: executionFailure, CleanupUnconfirmed: providerResult.ExitUnconfirmed})
			return
		}
		if spec.OperationKind == "run.start" && providerResult.Status == "completed" &&
			!emittedResponseText && providerResult.Output != "" {
			for _, projected := range projection.project(native.Event{Kind: native.EventText, ID: stableEventID("message", spec.TaskID+"\x00final"), Body: providerResult.Output}) {
				payload, marshalErr := json.Marshal(projected)
				if marshalErr != nil {
					finish(Result{Status: "failed", Error: fmt.Sprintf("marshal final provider output: %v", marshalErr)})
					return
				}
				if emitErr := emit(ctx, protocol.Event{Type: protocol.EventOperationEvent, SentAt: time.Now().UTC(), Payload: payload}); emitErr != nil {
					finish(Result{Status: "failed", Error: fmt.Sprintf("emit final provider output: %v", emitErr)})
					return
				}
			}
		}
		result := Result{
			Diagnostics:        providerResult.Diagnostics,
			FailureCode:        providerResult.FailureCode,
			CleanupConfirmed:   providerResult.ExitConfirmed,
			CleanupUnconfirmed: providerResult.ExitUnconfirmed,
			Status:             providerResult.Status,
			Output:             providerResult.Output,
			Error:              providerResult.Error,
			SessionID:          providerResult.SessionID,
			Usage:              providerResult.Usage,
			LastUsage:          providerResult.LastUsage,
			NativeResume:       providerResult.NativeResume,
			CompactionCount:    providerResult.CompactionCount,
			TurnID:             providerResult.TurnID,
			PreparedParked:     providerResult.Parked,
		}
		finish(result)
	}()
	return execution, nil
}

func normalizeMessage(message native.Event, operationID string) any {
	messageID := message.ID
	if messageID == "" {
		messageID = stableEventID("message", operationID)
	}
	callID := message.InvocationID
	if callID == "" {
		callID = stableEventID("call", operationID+"\x00"+message.ToolName+"\x00"+message.Body)
	}
	toolName := message.ToolName
	if toolName == "" {
		toolName = "provider_tool"
	}
	switch message.Kind {
	case native.EventReasoning:
		event := map[string]any{"type": "status.changed", "status": "thinking"}
		// Titles taken from a Runtime's own thinking text may quote what it
		// read, so they are redacted like tool inputs.
		if message.Title != "" {
			event["title"] = redact.Text(message.Title)
		}
		return event
	case native.EventToolCall:
		event := map[string]any{"type": "tool.called", "call_id": callID, "tool_name": toolName, "input": message.Input}
		if !message.ObservedAt.IsZero() {
			event["observed_at_unix_ms"] = message.ObservedAt.UnixMilli()
		}
		return event
	case native.EventToolOutput:
		event := map[string]any{"type": "tool.returned", "call_id": callID, "tool_name": toolName, "output": message.Output, "is_error": message.Status == "failed" || message.Status == "error" || message.Status == "cancelled"}
		if !message.ObservedAt.IsZero() {
			event["observed_at_unix_ms"] = message.ObservedAt.UnixMilli()
		}
		return event
	case native.EventStatus:
		if message.TurnID != "" {
			event := map[string]any{"type": "run.started", "turn_id": message.TurnID}
			if message.ProcessReused != nil {
				event["process_reused"] = *message.ProcessReused
			}
			if !message.SentAt.IsZero() {
				event["dispatched_at_unix_ms"] = message.SentAt.UnixMilli()
			}
			if message.SessionID != "" {
				event["session"] = map[string]any{"threadId": message.SessionID}
			}
			return event
		}
		return map[string]any{"type": "status.changed", "status": "working"}
	default:
		content := message.Body
		if content == "" {
			content = message.Output
		}
		event := map[string]any{"type": "message.delta", "message_id": messageID, "delta": content}
		if !message.ObservedAt.IsZero() {
			event["observed_at_unix_ms"] = message.ObservedAt.UnixMilli()
		}
		return event
	}
}

func stableEventID(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + "-" + hex.EncodeToString(digest[:16])
}

func cloneEnvironment(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

// retireClaudeResident stops the parked Claude process of a Runtime home, keyed
// like the Operation's LINGER_CLAUDE_SESSION_ROOT.
func retireClaudeResident(home string) error {
	return native.StopParkedClaudeResidentForCredentials(filepath.Join(home, "sessions"))
}

// codexBatchedInputs are the macOS desktop inputs that Codex sends only as
// run_actions steps.
var codexBatchedInputs = []any{"click", "double_click", "right_click", "drag", "scroll", "type_text", "press_key", "hotkey"}

// codexDirectLocalTools gives Codex the Daemon's own computer and browser
// tools as plain function tools, as Codex's computer-use plugin does with its
// REPL: outside code mode and never deferred. A call is then a JSON function
// call, not a script that wraps each tool in text(await tools.mcp__...).
// Desktop inputs go only through run_actions, Codex's one-script-per-call
// shape, so the model plans several steps in one call.
func codexDirectLocalTools(mcpConfig json.RawMessage, localTools []string) (json.RawMessage, error) {
	if len(mcpConfig) == 0 || len(localTools) == 0 {
		return mcpConfig, nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(mcpConfig, &parsed); err != nil {
		return nil, fmt.Errorf("Codex MCP configuration is invalid: %w", err)
	}
	servers, _ := parsed["mcpServers"].(map[string]any)
	for _, tool := range localTools {
		name, _, ok := strings.Cut(strings.TrimPrefix(tool, "mcp__"), "__")
		if settings, found := servers[name].(map[string]any); ok && found {
			settings["omit_tools_from"] = []any{"code_mode", "deferred"}
			if name == "computer" {
				settings["disabled_tools"] = codexBatchedInputs
			}
		}
	}
	return json.Marshal(parsed)
}

// prepareCodexPermissionReview readies a Context's CODEX_HOME for a reviewed
// Run: the execpolicy rules that allow read-only and TeamHub commands, managed
// MCP tools that always ask, and the PermissionRequest hook that reaches this
// Daemon. Without the hook a reviewed Run cannot start.
func prepareCodexPermissionReview(codexHome string, teamhubCommands []permission.TeamHubCommand, mcpConfig json.RawMessage) (*permission.CodexHook, json.RawMessage, error) {
	if err := permission.CodexWriteRules(codexHome, permission.CodexRules(teamhubCommands)); err != nil {
		return nil, nil, fmt.Errorf("write Codex permission rules: %w", err)
	}
	mcpConfig, err := permission.CodexPromptMCPTools(mcpConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("Codex MCP configuration is invalid: %w", err)
	}
	endpoint, err := permission.CodexSharedEndpoint()
	if err != nil {
		return nil, nil, fmt.Errorf("start Codex permission hook endpoint: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, fmt.Errorf("locate the Daemon for the Codex permission hook: %w", err)
	}
	return &permission.CodexHook{Endpoint: endpoint, Config: endpoint.HooksConfig(executable)}, mcpConfig, nil
}

// ReviewsPermissions reports whether this Operation answers the Runtime's own
// permission prompts through the Runtime permission review. Agent Service
// declares it per Run; session and preparation Operations never prompt.
func (spec OperationSpec) ReviewsPermissions() bool {
	return spec.PermissionReview && spec.OperationKind == "run.start"
}

// startsFreshSession reports whether a Run whose retained native session the
// Runtime refused may continue in a new session instead of failing.
func startsFreshSession(spec OperationSpec, result native.Outcome) bool {
	return spec.OperationKind == "run.start" && spec.ResumeSessionID != "" &&
		result.Status != "completed" && result.FailureCode == "session_not_found"
}
