// Model calls ask the Agent Service for one stateless model answer
// (POST /v1/model-calls). The Agent Service runs it on the Codex or Claude
// Runtime of the owner's Another Me Computer with the Runtime's default model,
// so TeamHub names only a reasoning effort and never a model.

package roomagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	agentapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const (
	// modelCallMaxWait is how long the Agent Service holds a request before it
	// answers MODEL_CALL_PENDING for background work still queued or running.
	modelCallMaxWait = 5 * time.Minute
	// transportGrace lets the Agent Service report its own timeout or pending
	// answer before TeamHub gives up on the request.
	transportGrace = 5 * time.Second
)

var (
	// ErrModelCallUnconfigured means TeamHub has no Agent Service URL or token.
	ErrModelCallUnconfigured = errors.New("Agent Service model calls are not configured")
	// ErrModelCallNoAnswer means a successful response lacked the requested answer.
	ErrModelCallNoAnswer = errors.New("model call returned no answer")
	// ErrModelCallComputerOffline means the owner's Computer cannot take the
	// call now (offline, updating or busy). It is not the call's fault, so a
	// background job waits for the Computer instead of spending an attempt.
	ErrModelCallComputerOffline = errors.New("the owner's Local Computer is offline")
	// ErrModelCallPending means background work is still queued or running on
	// the owner's Computer. Like an offline Computer it spends no attempt: the
	// same request later joins the work or receives its result.
	ErrModelCallPending = errors.New("the model call is still pending")
)

// Effort is the reasoning effort the Runtime's default model answers with.
type Effort string

// Reasoning efforts a model call may ask for; an empty Effort means EffortLow.
const (
	EffortLow    Effort = "low"
	EffortMedium Effort = "medium"
	EffortHigh   Effort = "high"
)

// Kind says what a model call is for. The Agent Service derives its priority,
// attempts, and default timeout from it.
type Kind = agentapi.ModelCallKind

// Kinds TeamHub asks for.
const (
	KindApproval = agentapi.ModelCallKindApproval
	KindVoiceAsk = agentapi.ModelCallKindVoiceAsk
	KindProfile  = agentapi.ModelCallKindProfile
	KindInsight  = agentapi.ModelCallKindInsight
)

// ModelCallOwner names the Human whose Another Me's Computer runs the call.
type ModelCallOwner struct{ TenantID, OwnerActorID string }

// ModelCallRequest is one stateless prompt.
type ModelCallRequest struct {
	Kind Kind
	// Key names the work, for example profile:<generation id>. A retry with
	// the same key and content joins the running call or receives its result.
	Key string
	// Owner is sent only when both ids are set; without it the Agent Service
	// uses the deployment's only Another Me.
	Owner        ModelCallOwner
	Effort       Effort
	Instructions string
	Input        string
	// Timeout bounds one Runtime attempt, each schema correction getting its
	// own; zero leaves the kind's default.
	Timeout time.Duration
	// SessionKey names the session a structured call belongs to: Codex answers
	// one session's calls in one resident thread that keeps the instructions
	// and the earlier calls.
	SessionKey string
	// RunOperationID is set only by an approval: the reviewed Run Operation,
	// whose queue place the call runs in while the Run holds one on the same
	// Runtime.
	RunOperationID string
}

// ModelCallStatusError is a non-200 Agent Service response. Code and Message come from
// its error body, which never repeats the prompt.
type ModelCallStatusError struct {
	Status        int
	Code, Message string
}

// Error reports the status and the Agent Service's error code and message.
func (e *ModelCallStatusError) Error() string {
	return fmt.Sprintf("model call status %d %s: %s", e.Status, e.Code, e.Message)
}

// Is reports a LOCAL_COMPUTER_OFFLINE answer as ErrModelCallComputerOffline
// and a MODEL_CALL_PENDING answer as ErrModelCallPending.
func (e *ModelCallStatusError) Is(target error) bool {
	switch target {
	case ErrModelCallComputerOffline:
		return e.Code == "LOCAL_COMPUTER_OFFLINE"
	case ErrModelCallPending:
		return e.Code == "MODEL_CALL_PENDING"
	}
	return false
}

// ModelCallClient calls the Agent Service model-call endpoint.
type ModelCallClient struct{ api *agentapi.ClientWithResponses }

// NewModelCallClient returns ErrModelCallUnconfigured when the Agent Service URL or token is empty.
// Each call waits at most until the Agent Service answers pending, not for the
// HTTP client's timeout.
func NewModelCallClient(baseURL, token string) (*ModelCallClient, error) {
	if strings.TrimSpace(baseURL) == "" || strings.TrimSpace(token) == "" {
		return nil, ErrModelCallUnconfigured
	}
	api, err := NewAgentManagementClient(baseURL, token, &http.Client{})
	if err != nil {
		return nil, err
	}
	return &ModelCallClient{api: api}, nil
}

// Structured asks for one JSON object matching schema and returns it with the
// model the Runtime reported, which may be empty. A json.RawMessage schema
// keeps its property order, which models tend to follow when they fill the
// object.
func (c *ModelCallClient) Structured(ctx context.Context, request ModelCallRequest, name string, schema any) (json.RawMessage, string, error) {
	answer, err := c.call(ctx, request, &output{Name: name, Schema: schema})
	if err != nil {
		return nil, "", err
	}
	if len(answer.Output) == 0 || string(answer.Output) == "null" {
		return nil, "", ErrModelCallNoAnswer
	}
	return answer.Output, answer.Model, nil
}

// Text asks for a free-text answer and returns it with the model the Runtime
// reported, which may be empty.
func (c *ModelCallClient) Text(ctx context.Context, request ModelCallRequest) (string, string, error) {
	answer, err := c.call(ctx, request, nil)
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(answer.Text) == "" {
		return "", "", ErrModelCallNoAnswer
	}
	return answer.Text, answer.Model, nil
}

// body is the generated request with the output schema left as the caller
// gave it; the outer Output field hides the generated one when encoded.
type body struct {
	agentapi.ModelCallRequest
	Output *output `json:"output,omitempty"`
}

type output struct {
	Name   string `json:"name"`
	Schema any    `json:"schema"`
}

type answer struct {
	Model  string          `json:"model"`
	Output json.RawMessage `json:"output"`
	Text   string          `json:"text"`
}

func (c *ModelCallClient) call(ctx context.Context, request ModelCallRequest, wanted *output) (answer, error) {
	payload := body{Output: wanted}
	payload.Kind = request.Kind
	payload.Key = request.Key
	payload.Input = request.Input
	if request.Timeout > 0 {
		timeout := int(request.Timeout.Milliseconds())
		payload.TimeoutMs = &timeout
	}
	if request.Instructions != "" {
		payload.Instructions = &request.Instructions
	}
	if request.SessionKey != "" {
		payload.SessionKey = &request.SessionKey
	}
	if request.RunOperationID != "" {
		payload.RunOperationId = &request.RunOperationID
	}
	if request.Effort != "" {
		effort := agentapi.ModelCallEffort(request.Effort)
		payload.Effort = &effort
	}
	if request.Owner.TenantID != "" && request.Owner.OwnerActorID != "" {
		payload.Owner = &struct {
			OwnerActorId agentapi.Id `json:"ownerActorId"`
			TenantId     agentapi.Id `json:"tenantId"`
		}{OwnerActorId: request.Owner.OwnerActorID, TenantId: request.Owner.TenantID}
	}
	raw, err := c.post(ctx, modelCallMaxWait, payload, c.api.CallModelWithBody)
	if err != nil {
		return answer{}, err
	}
	var result answer
	if err := json.Unmarshal(raw, &result); err != nil {
		return answer{}, fmt.Errorf("%w: %w", ErrModelCallNoAnswer, err)
	}
	return result, nil
}

type sender func(context.Context, string, io.Reader, ...agentapi.RequestEditorFn) (*http.Response, error)

// post sends payload through send, waiting up to budget plus transportGrace,
// and returns the 200 body; any other status is a StatusError.
func (c *ModelCallClient) post(ctx context.Context, budget time.Duration, payload any, send sender) ([]byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode model call: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, budget+transportGrace)
	defer cancel()
	response, err := send(ctx, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("model call transport failed: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("model call transport failed: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		failure := &ModelCallStatusError{Status: response.StatusCode}
		var envelope agentapi.ErrorResponse
		if json.Unmarshal(raw, &envelope) == nil {
			failure.Code, failure.Message = envelope.Error.Code, envelope.Error.Message
		}
		return nil, failure
	}
	return raw, nil
}
