package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// MaxFrameBytes is the Runner Gateway frame limit; the Agent Service closes
// the connection on a larger frame.
const MaxFrameBytes = 4 * 1024 * 1024
const defaultWriteTimeout = 10 * time.Second

type GatewayControlPlane struct {
	URL           string
	BearerToken   string
	Dialer        *websocket.Dialer
	MaxFrameBytes int64
	// WriteTimeout bounds each socket write; non-positive values use 10 seconds.
	WriteTimeout time.Duration
}

func (p GatewayControlPlane) Connect(ctx context.Context, hello Hello) (Stream, error) {
	if p.URL == "" {
		return nil, errors.New("Runner Gateway URL is empty")
	}
	if p.BearerToken == "" {
		return nil, errors.New("Runner Gateway credential is empty")
	}
	parsed, err := url.Parse(p.URL)
	if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		return nil, fmt.Errorf("Runner Gateway URL is invalid: %q", p.URL)
	}
	dialer := p.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+p.BearerToken)
	socket, response, err := dialer.DialContext(ctx, p.URL, header)
	if err != nil {
		if response == nil {
			return nil, &GatewayUnreachableError{Err: fmt.Errorf("connect Runner Gateway: %w", err)}
		}
		_ = response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, &AuthenticationError{StatusCode: response.StatusCode}
		}
		// A rejected upgrade reports only "bad handshake"; the status tells a proxy outage from a Gateway fault.
		err = fmt.Errorf("connect Runner Gateway: HTTP %d: %w", response.StatusCode, err)
		if response.StatusCode >= http.StatusInternalServerError || response.StatusCode == http.StatusTooManyRequests {
			return nil, &GatewayUnreachableError{Err: err}
		}
		return nil, err
	}
	maxFrameBytes := p.MaxFrameBytes
	if maxFrameBytes <= 0 {
		maxFrameBytes = MaxFrameBytes
	}
	socket.SetReadLimit(maxFrameBytes)
	writeTimeout := p.WriteTimeout
	if writeTimeout <= 0 {
		writeTimeout = defaultWriteTimeout
	}
	return &gatewayStream{socket: socket, hello: hello, writeMu: &sync.Mutex{}, writeTimeout: writeTimeout}, nil
}

type gatewayStream struct {
	socket       *websocket.Conn
	hello        Hello
	writeMu      *sync.Mutex
	writeTimeout time.Duration
	closed       atomic.Bool
	close        sync.Once
	closeErr     error
}

func (s *gatewayStream) Receive(ctx context.Context) (protocol.Command, error) {
	if err := ctx.Err(); err != nil {
		return protocol.Command{}, err
	}
	readDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Close()
		case <-readDone:
		}
	}()
	defer close(readDone)
	if deadline, ok := ctx.Deadline(); ok {
		if err := s.socket.SetReadDeadline(deadline); err != nil {
			return protocol.Command{}, err
		}
	}
	_, encoded, err := s.socket.ReadMessage()
	if err != nil {
		var closeError *websocket.CloseError
		if errors.As(err, &closeError) && closeError.Code == websocket.ClosePolicyViolation &&
			strings.HasPrefix(closeError.Text, "upgrade_required:") {
			return protocol.Command{}, &UpgradeRequiredError{Reason: closeError.Text}
		}
		return protocol.Command{}, err
	}
	command, err := decodeGatewayCommand(encoded)
	if err != nil {
		slog.Warn("runner.gateway.protocol_error", "error", err)
		_ = s.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseProtocolError, "Invalid Runner Gateway command"), time.Now().Add(s.writeTimeout))
		_ = s.Close()
		return protocol.Command{}, err
	}
	return command, nil
}

// agentShapes decodes each Agent frame into its generated shape, which checks
// the keys and fixed values the schema requires.
var agentShapes = map[string]func() wire.Shape{
	"RunnerWelcome":                func() wire.Shape { return &wire.RunnerWelcome{} },
	"RunnerReconciled":             func() wire.Shape { return &wire.RunnerReconciled{} },
	"RuntimeRegistrationSnapshot":  func() wire.Shape { return &wire.RuntimeRegistrationSnapshot{} },
	"AgentRunnerEnsure":            func() wire.Shape { return &wire.AgentRunnerEnsure{} },
	"AgentRunnerRemove":            func() wire.Shape { return &wire.AgentRunnerRemove{} },
	"AgentCliCredentialPut":        func() wire.Shape { return &wire.AgentCliCredentialPut{} },
	"DebugInspect":                 func() wire.Shape { return &wire.DebugInspect{} },
	"CapabilitySkillsScan":         func() wire.Shape { return &wire.CapabilitySkillsScan{} },
	"CapabilityBrowserConnect":     func() wire.Shape { return &wire.CapabilityBrowserConnect{} },
	"CapabilityComputerPermission": func() wire.Shape { return &wire.CapabilityComputerPermission{} },
	"OperationPrepare":             func() wire.Shape { return &wire.OperationPrepare{} },
	"ProviderPrepare":              func() wire.Shape { return &wire.ProviderPrepare{} },
	"SessionCompact":               func() wire.Shape { return &wire.SessionCompact{} },
	"ModelInvoke":                  func() wire.Shape { return &wire.ModelInvoke{} },
	"OperationStart":               func() wire.Shape { return &wire.OperationStart{} },
	"OperationInput":               func() wire.Shape { return &wire.OperationInput{} },
	"OperationCancel":              func() wire.Shape { return &wire.OperationCancel{} },
	"OperationAck":                 func() wire.Shape { return &wire.OperationAck{} },
	"ComputerToolCall":             func() wire.Shape { return &wire.ComputerToolCall{} },
}

func decodeGatewayCommand(encoded []byte) (protocol.Command, error) {
	message, err := wire.Discriminate(encoded, wire.AgentToDaemonMessages)
	if err != nil {
		return protocol.Command{}, fmt.Errorf("decode Runner Gateway command: %w", err)
	}
	shape := agentShapes[message.Name]
	if shape == nil {
		return protocol.Command{}, fmt.Errorf("Runner Gateway command %s has no decoder", message.Name)
	}
	if err := wire.Decode(encoded, shape()); err != nil {
		return protocol.Command{}, fmt.Errorf("decode Runner Gateway %s: %w", message.Name, err)
	}
	var command protocol.Command
	if err := json.Unmarshal(encoded, &command); err != nil {
		return protocol.Command{}, fmt.Errorf("decode Runner Gateway command: %w", err)
	}
	command.Type = protocol.Route(message)
	if command.Type == protocol.CommandDebugInspect {
		var inspection struct {
			DetachedHistory *bool `json:"detached_history"`
		}
		if err := json.Unmarshal(encoded, &inspection); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Debug history read: %w", err)
		}
		if inspection.DetachedHistory == nil && (command.RegistrationID == "" || command.AssignmentRevision == 0) {
			return protocol.Command{}, errors.New("Debug history read requires a Runtime Assignment")
		}
	}
	switch command.Type {
	case protocol.CommandRegistrationSnapshot:
		var snapshot struct {
			Registrations []RuntimeRegistration `json:"registrations"`
		}
		if err := json.Unmarshal(encoded, &snapshot); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Registration snapshot: %w", err)
		}
		command.Payload, err = json.Marshal(snapshot.Registrations)
		if err != nil {
			return protocol.Command{}, fmt.Errorf("encode Registration snapshot payload: %w", err)
		}
	case protocol.CommandOperationPrepare:
		var envelope struct {
			Runtime          json.RawMessage `json:"runtime"`
			SessionOptions   json.RawMessage `json:"session_options"`
			Session          json.RawMessage `json:"session"`
			MCPRelays        json.RawMessage `json:"mcp_relays"`
			PermissionReview bool            `json:"permission_review"`
		}
		if err := json.Unmarshal(encoded, &envelope); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Operation preparation: %w", err)
		}
		command.OperationKind = "run.start"
		command.Payload, err = json.Marshal(map[string]any{
			"kind": "run.start", "runtime": envelope.Runtime,
			"session_options": envelope.SessionOptions, "session": envelope.Session,
			"run_resources": map[string]any{"mcp_servers": envelope.MCPRelays},
			"run_context":   map[string]any{"permission_review": envelope.PermissionReview},
		})
		if err != nil {
			return protocol.Command{}, fmt.Errorf("encode Operation preparation request: %w", err)
		}
	case protocol.CommandOperationStart:
		var envelope struct {
			Request json.RawMessage `json:"request"`
		}
		var request struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(encoded, &envelope); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Operation request: %w", err)
		}
		if err := json.Unmarshal(envelope.Request, &request); err != nil || request.Kind == "" {
			return protocol.Command{}, errors.New("Operation request is missing")
		}
		command.OperationKind = request.Kind
		command.Payload = append(json.RawMessage(nil), envelope.Request...)
	case protocol.CommandOperationInput:
		var input struct {
			ExpectedTurnID      string          `json:"expected_turn_id"`
			InputContextViewRef json.RawMessage `json:"input_context_view_ref"`
			Input               json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(encoded, &input); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Operation input: %w", err)
		}
		command.ExpectedTurnID = input.ExpectedTurnID
		command.InputContextViewRef = append(json.RawMessage(nil), input.InputContextViewRef...)
		command.Input = append(json.RawMessage(nil), input.Input...)
	case protocol.CommandOperationCancel:
		var cancel struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(encoded, &cancel); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Operation cancellation: %w", err)
		}
		command.Payload, err = json.Marshal(cancel)
		if err != nil {
			return protocol.Command{}, fmt.Errorf("encode Operation cancellation payload: %w", err)
		}
	case protocol.CommandAgentRunnerEnsure:
		var lifecycle struct {
			Runtime          json.RawMessage `json:"runtime"`
			WorkspaceGrantID string          `json:"workspace_grant_id"`
		}
		if err := json.Unmarshal(encoded, &lifecycle); err != nil {
			return protocol.Command{}, fmt.Errorf("decode Agent Runner lifecycle command: %w", err)
		}
		command.Payload, err = json.Marshal(lifecycle)
		if err != nil {
			return protocol.Command{}, fmt.Errorf("encode Agent Runner lifecycle payload: %w", err)
		}
	case protocol.CommandProviderPrepare,
		protocol.CommandSessionCompact, protocol.CommandModelInvoke, protocol.CommandComputerToolCall,
		protocol.CommandDebugInspect, protocol.CommandAgentCLICredentialPut,
		protocol.CommandCapabilitySkillsScan, protocol.CommandCapabilityBrowserConnect,
		protocol.CommandCapabilityComputerPermission:
		// Their handlers decode the generated shape from the frame itself.
		command.Payload = append(json.RawMessage(nil), encoded...)
	}
	return command, nil
}

// ConnectionFailure classifies why a connection ended before runner.welcome,
// as evidence about this daemon's release.
type ConnectionFailure int

const (
	// FailureOther may be caused by this release.
	FailureOther ConnectionFailure = iota
	// FailureUnavailable says nothing about this release: the network, a proxy,
	// a restarting Gateway, TeamHub, or a revoked Runner credential.
	FailureUnavailable
	// FailureIncompatible is the Gateway refusing this release's protocol.
	FailureIncompatible
)

// Close reasons the Agent Runner Gateway sends about the Runner credential.
const (
	credentialScopeViolationReason          = "Runner credential scope violation"          //nolint:gosec // close reason text, not a credential
	credentialVerificationUnavailableReason = "Runner credential verification unavailable" //nolint:gosec // close reason text, not a credential
)

// IsGatewayRestart reports whether the Gateway closed the session because the
// Agent Service is going away (1001) or restarting (1012).
func IsGatewayRestart(err error) bool {
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) {
		return false
	}
	return closeError.Code == websocket.CloseGoingAway || closeError.Code == websocket.CloseServiceRestart
}

func ClassifyConnectionFailure(err error) ConnectionFailure {
	var upgradeRequired *UpgradeRequiredError
	if errors.As(err, &upgradeRequired) {
		return FailureIncompatible
	}
	var closeError *websocket.CloseError
	if errors.As(err, &closeError) {
		switch closeError.Code {
		case websocket.CloseProtocolError:
			return FailureIncompatible
		// 1008 without upgrade_required: a revoked or expired credential, or a
		// scope violation, which this daemon's own hello triggers.
		case websocket.ClosePolicyViolation:
			if closeError.Text == credentialScopeViolationReason {
				return FailureOther
			}
			return FailureUnavailable
		case websocket.CloseInternalServerErr:
			if closeError.Text == credentialVerificationUnavailableReason {
				return FailureUnavailable
			}
			return FailureOther
		case websocket.CloseGoingAway, websocket.CloseAbnormalClosure,
			websocket.CloseServiceRestart, websocket.CloseTryAgainLater:
			return FailureUnavailable
		}
		return FailureOther
	}
	// HTTP 401/403 is FailureOther: a release that breaks its credential header
	// gets it too, and a revoked credential only costs a rollback.
	var unreachable *GatewayUnreachableError
	var networkError net.Error
	if errors.As(err, &unreachable) || errors.As(err, &networkError) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return FailureUnavailable
	}
	return FailureOther
}

// GatewayUnreachableError is a dial that got no response or a proxy or
// Gateway outage status.
type GatewayUnreachableError struct {
	Err error
}

func (e *GatewayUnreachableError) Error() string { return e.Err.Error() }

func (e *GatewayUnreachableError) Unwrap() error { return e.Err }

type UpgradeRequiredError struct {
	Reason string
}

func (e *UpgradeRequiredError) Error() string {
	return "Runner Gateway requires a Local Computer upgrade"
}

func (s *gatewayStream) Send(ctx context.Context, event protocol.Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.closed.Load() {
		return errors.New("Runner Gateway stream is closed")
	}
	var value any
	switch {
	case event.Type == protocol.EventDaemonHello:
		hello, err := s.runnerHello()
		if err != nil {
			return err
		}
		value = hello
	case event.Type == protocol.EventRuntimeObserved:
		var payload struct {
			Count uint64 `json:"count"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode Registration receipt payload: %w", err)
		}
		value = wire.RuntimeRegistrationObserved{
			Type: wire.TypeRuntimeRegistrationObserved, ProtocolVersion: protocol.Version,
			CommandID: event.CommandID, RunnerID: s.hello.RunnerID,
			ConnectionEpoch: event.ConnectionEpoch, ObservedCount: payload.Count,
		}
	case event.Type == protocol.EventRuntimeDiagnostics:
		var diagnostics []wire.RuntimeDiagnostic
		if err := json.Unmarshal(event.Payload, &diagnostics); err != nil {
			return fmt.Errorf("decode Runtime diagnostics: %w", err)
		}
		value = wire.RunnerRuntimeDiagnostics{
			Type: wire.TypeRunnerRuntimeDiagnostics, ProtocolVersion: protocol.Version,
			RunnerID: event.RunnerID, SentAt: event.SentAt.Format(time.RFC3339Nano),
			Revision: event.Revision, RuntimeDiagnostics: diagnostics,
		}
	case event.Type == protocol.EventRunnerHeartbeat:
		var payload struct {
			ActiveOperationIDs []string              `json:"active_operation_ids"`
			ManagedServices    []wire.ManagedService `json:"managed_services"`
		}
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			return fmt.Errorf("decode Runner heartbeat payload: %w", err)
		}
		if payload.ActiveOperationIDs == nil {
			payload.ActiveOperationIDs = []string{}
		}
		value = wire.RunnerHeartbeat{
			Type: wire.TypeRunnerHeartbeat, ProtocolVersion: protocol.Version,
			RunnerID: event.RunnerID, SentAt: event.SentAt.Format(time.RFC3339Nano),
			ActiveOperationIDs: payload.ActiveOperationIDs, ManagedServices: payload.ManagedServices,
		}
	case replyShapes[event.Type] != nil:
		frame, err := replyFrame(event)
		if err != nil {
			return err
		}
		value = frame
	case event.Type == protocol.EventCapabilitySkillsScanned || event.Type == protocol.EventCapabilitySkillsFailed ||
		event.Type == protocol.EventCapabilityBrowserConnected || event.Type == protocol.EventCapabilityBrowserFailed ||
		event.Type == protocol.EventCapabilityComputerPermissionSucceeded || event.Type == protocol.EventCapabilityComputerPermissionFailed ||
		event.Type == protocol.EventProviderPrepared || event.Type == protocol.EventSessionCompacted ||
		event.Type == protocol.EventModelInvoked || event.Type == protocol.EventComputerToolResult:
		// Their handlers already encode the generated wire shape.
		value = event.Payload
	default:
		return fmt.Errorf("Runner Gateway event %s has no wire shape", event.Type)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode Runner Gateway event: %w", err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.closed.Load() {
		return errors.New("Runner Gateway stream is closed")
	}
	deadline := time.Now().Add(s.writeTimeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := s.socket.SetWriteDeadline(deadline); err != nil {
		_ = s.Close()
		return err
	}
	if err := s.socket.WriteMessage(websocket.TextMessage, encoded); err != nil {
		_ = s.Close()
		return fmt.Errorf("send Runner Gateway event: %w", err)
	}
	return nil
}

// ReleaseVersion is the Computer release this build reports; release builds
// set it at link time.
var ReleaseVersion = "dev"

// replyShapes builds the generated wire shape of each Operation, Agent Runner,
// CLI credential and Debug reply. Each frame starts from its literal fields,
// takes the generated identity it shares with its family and the reply's own
// payload, then the values the schema fixes for it.
var replyShapes = map[string]func(protocol.Event) (wire.Shape, error){
	protocol.EventOperationPrepared: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationPrepared{CommandID: event.CommandID}, event, event.Payload)
	},
	protocol.EventOperationAccepted: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationAccepted{Seq: event.Sequence, CommandID: event.CommandID}, event, event.Payload)
	},
	protocol.EventOperationEvent: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationEvent{Seq: event.Sequence, Event: event.Payload}, event, nil)
	},
	protocol.EventOperationInputAck: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationInputAck{Seq: event.Sequence, CommandID: event.CommandID}, event, event.Payload)
	},
	protocol.EventOperationInputClosed: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationInputClosed{CommandID: event.CommandID}, event, event.Payload)
	},
	protocol.EventOperationInputRejected: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationInputRejected{Seq: event.Sequence, CommandID: event.CommandID}, event, event.Payload)
	},
	protocol.EventOperationCompleted: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationCompleted{Seq: event.Sequence, Result: event.Payload}, event, nil)
	},
	// A failure payload is the error plus the usage and resume measurements
	// that sit beside it on the frame.
	protocol.EventOperationFailed: func(event protocol.Event) (wire.Shape, error) {
		stage := event.Stage
		if stage == "" {
			stage = "runtime_execution"
		}
		frame := &wire.OperationFailed{Seq: event.Sequence, Stage: stage}
		if err := unmarshalPayload(event.Payload, &frame.Error); err != nil {
			return nil, err
		}
		return operationFrame(frame, event, event.Payload)
	},
	protocol.EventOperationCancelled: func(event protocol.Event) (wire.Shape, error) {
		return operationFrame(&wire.OperationCancelled{Seq: event.Sequence}, event, event.Payload)
	},
	protocol.EventAgentRunnerReady: func(event protocol.Event) (wire.Shape, error) {
		return agentRunnerFrame(&wire.AgentRunnerReady{RunnerPID: uint64(os.Getpid())}, event, event.Payload)
	},
	protocol.EventAgentRunnerRemoved: func(event protocol.Event) (wire.Shape, error) {
		return agentRunnerFrame(&wire.AgentRunnerRemoved{}, event, nil)
	},
	protocol.EventAgentRunnerFailed: func(event protocol.Event) (wire.Shape, error) {
		return agentRunnerFrame(&wire.AgentRunnerFailed{Error: wire.AgentRunnerError{
			Code: "AGENT_RUNNER_FAILED", Message: "Agent Runner lifecycle failed",
		}}, event, nil)
	},
	// The stored report carries only the stored fields, never the token.
	protocol.EventAgentCLICredentialStored: func(event protocol.Event) (wire.Shape, error) {
		return agentRunnerFrame(&wire.AgentCliCredentialStored{}, event, event.Payload)
	},
	protocol.EventAgentCLICredentialFailed: func(event protocol.Event) (wire.Shape, error) {
		return agentRunnerFrame(&wire.AgentCliCredentialFailed{}, event, event.Payload)
	},
	protocol.EventDebugInspected: func(event protocol.Event) (wire.Shape, error) {
		frame := &wire.DebugInspected{
			WorkspaceGrantID: event.WorkspaceGrantID, ExecutionContextKey: event.ExecutionContextKey,
			RuntimeInstanceID: event.RuntimeInstanceID, ViewDigest: event.ViewDigest,
		}
		if event.ViewDigest == "" {
			detached := true
			frame.DetachedHistory = &detached
		}
		if err := unmarshalPayload(event.Payload, &frame.Result); err != nil {
			return nil, err
		}
		return agentRunnerFrame(frame, event, nil)
	},
}

// replyFrame builds the wire shape of a reply event.
func replyFrame(event protocol.Event) (wire.Shape, error) {
	build := replyShapes[event.Type]
	if build == nil {
		return nil, fmt.Errorf("Runner Gateway event %s has no reply shape", event.Type)
	}
	frame, err := build(event)
	if err != nil {
		return nil, fmt.Errorf("encode Runner Gateway %s: %w", event.Type, err)
	}
	return frame, nil
}

func unmarshalPayload(payload json.RawMessage, target any) error {
	if len(payload) == 0 {
		return nil
	}
	return json.Unmarshal(payload, target)
}

func operationFrame(frame wire.Shape, event protocol.Event, payload json.RawMessage) (wire.Shape, error) {
	identity := wire.OperationIdentity{
		ExecutionContextKey: event.ExecutionContextKey, RuntimeInstanceID: event.RuntimeInstanceID,
		TenantID: event.TenantID, RegistrationID: event.RegistrationID,
		AssignmentRevision: event.AssignmentRevision, RunnerID: event.RunnerID, AgentID: event.AgentID,
		OperationID: event.OperationID, ConnectionEpoch: event.ConnectionEpoch,
		RunnerRevision: event.RunnerRevision, Generation: event.Generation,
		ExecutionLeaseID: event.ExecutionLeaseID, WorkspaceGrantID: event.WorkspaceGrantID,
		RuntimeType: event.RuntimeType,
	}
	if len(event.ContextViewRef) > 0 {
		if err := json.Unmarshal(event.ContextViewRef, &identity.ContextViewRef); err != nil {
			return nil, fmt.Errorf("decode Operation Context View identity: %w", err)
		}
	}
	return frame, composeFrame(frame, identity, payload)
}

func agentRunnerFrame(frame wire.Shape, event protocol.Event, payload json.RawMessage) (wire.Shape, error) {
	identity := wire.AgentRunnerWireIdentity{
		CommandID: event.CommandID, RunnerID: event.RunnerID, TenantID: event.TenantID,
		AgentID: event.AgentID, ConnectionEpoch: event.ConnectionEpoch, RunnerRevision: event.RunnerRevision,
	}
	if event.RegistrationID != "" {
		revision := event.AssignmentRevision
		identity.RegistrationID, identity.AssignmentRevision = event.RegistrationID, &revision
	}
	return frame, composeFrame(frame, identity, payload)
}

// composeFrame overlays identity and payload onto frame, then the values the
// schema fixes for it. A payload key the frame does not have is dropped.
func composeFrame(frame wire.Shape, identity any, payload json.RawMessage) error {
	encodedIdentity, err := json.Marshal(identity)
	if err != nil {
		return err
	}
	fixed, err := json.Marshal(frame.FixedFields())
	if err != nil {
		return err
	}
	for _, part := range []json.RawMessage{encodedIdentity, payload, fixed} {
		if err := unmarshalPayload(part, frame); err != nil {
			return err
		}
	}
	return nil
}

func (s *gatewayStream) runnerHello() (wire.RunnerHello, error) {
	hello := wire.RunnerHello{
		Type:            wire.TypeRunnerHello,
		ProtocolVersion: s.hello.ProtocolVersion,
		DaemonVersion:   ReleaseVersion,
		Platform:        nativePlatform(),
		RunnerID:        s.hello.RunnerID,
		DisplayName:     s.hello.DisplayName,
		ConnectionNonce: s.hello.ConnectionNonce,
		DaemonIdentity: wire.RunnerHelloDaemonIdentity{
			DaemonID:        s.hello.Identity.DaemonID,
			PublicKey:       base64.StdEncoding.EncodeToString(s.hello.Identity.PublicKey),
			IdentityVersion: 1,
			Proof:           base64.StdEncoding.EncodeToString(s.hello.Signature),
		},
		SentAt:       s.hello.SentAt.Format(time.RFC3339Nano),
		Runtimes:     append([]string{}, s.hello.Runtimes...),
		Capabilities: append([]string{}, s.hello.Capabilities...),
	}
	if s.hello.Capacity != nil {
		capacity := uint64(*s.hello.Capacity)
		hello.Capacity = &capacity
	}
	for _, part := range []struct {
		raw    json.RawMessage
		target any
	}{
		{s.hello.RuntimeDiagnostics, &hello.RuntimeDiagnostics},
		{s.hello.WorkspaceGrants, &hello.WorkspaceGrants},
		{s.hello.AgentRunners, &hello.AgentRunners},
		{s.hello.ActiveOperations, &hello.ActiveOperations},
	} {
		if len(part.raw) == 0 {
			continue
		}
		if err := json.Unmarshal(part.raw, part.target); err != nil {
			return wire.RunnerHello{}, fmt.Errorf("encode Runner hello: %w", err)
		}
	}
	registrations, err := json.Marshal(s.hello.Registrations)
	if err != nil {
		return wire.RunnerHello{}, fmt.Errorf("encode Runner hello: %w", err)
	}
	if err := json.Unmarshal(registrations, &hello.RuntimeRegistrations); err != nil {
		return wire.RunnerHello{}, fmt.Errorf("encode Runner hello: %w", err)
	}
	// Required arrays are present even when empty.
	if hello.RuntimeDiagnostics == nil {
		hello.RuntimeDiagnostics = []wire.RuntimeDiagnostic{}
	}
	if hello.WorkspaceGrants == nil {
		hello.WorkspaceGrants = []wire.WorkspaceGrant{}
	}
	if hello.AgentRunners == nil {
		hello.AgentRunners = []json.RawMessage{}
	}
	if hello.ActiveOperations == nil {
		hello.ActiveOperations = []wire.ActiveOperation{}
	}
	if hello.RuntimeRegistrations == nil {
		hello.RuntimeRegistrations = []wire.RuntimeRegistrationObservation{}
	}
	return hello, nil
}

func (s *gatewayStream) Close() error {
	s.close.Do(func() {
		s.closed.Store(true)
		s.closeErr = s.socket.Close()
	})
	return s.closeErr
}

var _ ControlPlane = GatewayControlPlane{}
var _ Stream = (*gatewayStream)(nil)

type AuthenticationError struct {
	StatusCode int
}

func (e *AuthenticationError) Error() string {
	return fmt.Sprintf("Runner Gateway rejected daemon credential with HTTP %d", e.StatusCode)
}

func nativePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
