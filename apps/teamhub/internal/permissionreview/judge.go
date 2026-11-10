package permissionreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// Client judges through the shared Agent Service model call with strict JSON
// Schema output, on the sponsor's Agent Runtime at low effort. The call goes
// first in its Runtime's queue, or runs in the reviewed Run's place when that
// Run holds one on the same Runtime, and makes one Runtime attempt without a
// schema correction, so a verdict fits the review timeout. The reviews of one Context share a session, as Codex guardian's
// reviews of one conversation share its reviewer: the policy and earlier
// reviews stay in the model's cached prompt, and only the new review request
// is sent. Only the policy, rendering, and validation in this package live
// here.
type Client struct {
	Models *roomagent.ModelCallClient
	// Timeout bounds the single Runtime attempt.
	Timeout time.Duration
}

// ErrUnavailable wraps every transport, status, and output failure. The service
// asks the sponsor to approve the exact action rather than treating a failed
// judgment as permission to execute it.
var ErrUnavailable = errors.New("permission review unavailable")

// Judge reviews one action. Any failure returns ErrUnavailable. A valid answer
// is final whatever it decides: retrying until the model says allow would not
// be a review.
func (c Client) Judge(ctx context.Context, request Request) (Verdict, error) {
	raw, _, err := c.Models.Structured(ctx, roomagent.ModelCallRequest{
		Kind:           roomagent.KindApproval,
		Key:            "approval:" + request.Owner.TenantID + ":" + request.Owner.OwnerActorID,
		Owner:          request.Owner,
		Instructions:   SystemPrompt(),
		Input:          Render(request),
		Timeout:        c.Timeout,
		SessionKey:     sessionKey(request.ContextKey),
		RunOperationID: request.RunOperationID,
	}, "permission_review", outputSchema)
	if err != nil {
		return Verdict{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	output, err := parseOutput(raw)
	if err != nil {
		return Verdict{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	verdict, err := Validate(output)
	if err != nil {
		return Verdict{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return verdict, nil
}

// sessionKey keeps the Context key opaque and within the model call's 200
// characters.
func sessionKey(contextKey string) string {
	if contextKey == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(contextKey))
	return "permission-review:" + hex.EncodeToString(digest[:16])
}

func parseOutput(content json.RawMessage) (ModelOutput, error) {
	// The Agent Service runs the call on the sponsor's Agent Runtime through
	// its Local Computer, and not every Runtime enforces the schema: one may
	// add a field of its own. Extra fields are ignored, but every required field
	// must be present, so a renamed field cannot silently read as empty.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(content, &fields); err != nil {
		return ModelOutput{}, fmt.Errorf("decode model output: %w", err)
	}
	for _, name := range requiredOutputFields {
		if _, ok := fields[name]; !ok {
			return ModelOutput{}, fmt.Errorf("model output lacks %s", name)
		}
	}
	var output ModelOutput
	if err := json.Unmarshal(content, &output); err != nil {
		return ModelOutput{}, fmt.Errorf("decode model output: %w", err)
	}
	return output, nil
}

var requiredOutputFields = []string{"risk_level", "user_authorization", "decision", "rationale"}

// outputSchema is raw JSON so property order is kept: models tend to fill
// fields in schema order, and risk and authorization must come before the
// decision. (A Go map would be marshaled alphabetically.)
var outputSchema = json.RawMessage(`{
  "type": "object",
  "additionalProperties": false,
  "required": ["risk_level", "user_authorization", "decision", "rationale"],
  "properties": {
    "risk_level": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
    "user_authorization": {"type": "string", "enum": ["high", "medium", "low", "unknown"]},
    "decision": {"type": "string", "enum": ["allow", "needs_approval", "deny"]},
    "rationale": {"type": "string"}
  }
}`)
