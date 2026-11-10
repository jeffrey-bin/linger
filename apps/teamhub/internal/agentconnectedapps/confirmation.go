package agentconnectedapps

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// PreparedConfirmation is an authorized call that needs the sponsor's
// confirmation, ready to be stored with its card.
type PreparedConfirmation struct {
	Connection externalsource.AgentToolConnection
	Action     json.RawMessage
	Digest     string
	Card       typedcard.ConnectorWriteView
}

// Result is what Execute did with a call: ran it, with its Data, or held it
// for the sponsor's confirmation, with the card to post.
type Result struct {
	Data         any
	Confirmation *PreparedConfirmation
}

// confirmationAction is the stored call. DraftDigest pins the content of a
// draft that a send-draft call sends, which TeamHub read to build the card.
type confirmationAction struct {
	ToolSlug    string         `json:"tool_slug,omitempty"`
	ToolVersion string         `json:"tool_version,omitempty"`
	Arguments   map[string]any `json:"arguments,omitempty"`
	DraftDigest string         `json:"draft_digest,omitempty"`
}

// prepareConfirmation builds the stored call and its card from what will run
// for an authorized call on an active connection.
func (s *Service) prepareConfirmation(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (Result, error) {
	card := describeConfirmation(connection, action)
	// A tool without its own card layout shows only its arguments, so they
	// must fit on the card: the sponsor approves nothing they cannot see.
	if card.Title == "Run "+action.ToolSlug && len([]rune(jsonText(action.Arguments, math.MaxInt))) > maxCardInput {
		return Result{}, &Error{Code: "invalid_input", Message: "The call is too large to show on a confirmation card",
			Issues: []Issue{{Path: "arguments", Code: "too_large_to_confirm", Message: "The arguments must fit on the sponsor's confirmation card"}}}
	}
	if read := draftReadTool[action.ToolSlug]; read != "" {
		message, err := s.readDraft(ctx, connection, action)
		if err != nil {
			return Result{}, err
		}
		card.Message = message
		card.Title = mailTitle("Send an email", message.To)
		action.DraftDigest = digestOf(message)
	}
	encoded, err := json.Marshal(action)
	if err != nil {
		return Result{}, err
	}
	return Result{Confirmation: &PreparedConfirmation{
		Connection: connection, Action: encoded, Card: card,
		Digest: digestOf(map[string]any{"connection_id": connection.ID, "action": action}),
	}}, nil
}

// ExecuteConfirmed runs a stored call once after the sponsor approved it. The
// Agent's current authority over the connection is checked again, since it may
// have changed while the card waited. It reports "succeeded", "failed" (the
// call did not take effect), or "unknown", with a short outcome.
func (s *Service) ExecuteConfirmed(ctx context.Context, decisionID, tenantID, agentActorID, connectionID string, stored json.RawMessage) (status, outcome string, data any) {
	var action confirmationAction
	decoder := json.NewDecoder(bytes.NewReader(stored))
	decoder.UseNumber()
	if err := decoder.Decode(&action); err != nil {
		return "failed", "TeamHub could not read the stored call.", nil
	}
	if s == nil || s.pool == nil || s.connections == nil || s.provider == nil {
		return "failed", "Connected app tools are unavailable.", nil
	}
	connection, err := s.grantedConnection(ctx, tenantID, agentActorID, connectionID)
	if err != nil {
		return "failed", "The Agent can no longer use this connected account.", nil
	}
	defer func() {
		s.logCall(ctx, "confirmation", connection, action.ToolSlug, action.ToolVersion, status, "decision_id", decisionID)
	}()
	if err := s.checkConnectionActive(ctx, connection); err != nil {
		return "failed", "The connected account is not active.", nil
	}
	if _, err := s.pinnedTool(ctx, connection, action.ToolSlug, action.ToolVersion, "execute"); err != nil {
		var domain *Error
		if errors.As(err, &domain) && len(domain.Issues) > 0 {
			// A pinned version that is gone names itself.
			return "failed", domain.Message + ".", nil
		}
		if errors.As(err, &domain) && domain.Code == "tool_not_found" {
			return "failed", "The connected app tool is no longer available.", nil
		}
		return "failed", "TeamHub could not reach the connected app, so the call was not run.", nil
	}
	if action.DraftDigest != "" {
		message, err := s.readDraft(ctx, connection, action)
		if err != nil {
			return "failed", "TeamHub could not read the draft to check it, so it was not sent.", nil
		}
		if digestOf(message) != action.DraftDigest {
			return "failed", "The draft changed after the card was posted, so it was not sent.", nil
		}
	}
	execution, err := s.provider.ExecuteTool(ctx, connection.UpstreamConnectionID, connection.UserID,
		action.ToolSlug, action.ToolVersion, action.Arguments)
	if err != nil {
		return failedOrUnknown(err)
	}
	if !execution.Successful {
		outcome := "The connected application rejected the call."
		if detail := providerErrorText(execution.Error); detail != "" {
			outcome += " " + detail
		}
		return "failed", outcome, nil
	}
	return "succeeded", "", sanitizeValue(execution.Data)
}

// grantedConnection checks the Agent's current grant on the connection
// without a credential token: the settle job acts on the sponsor's approval.
func (s *Service) grantedConnection(ctx context.Context, tenantID, agentActorID, connectionID string) (externalsource.AgentToolConnection, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return externalsource.AgentToolConnection{}, err
	}
	defer tx.Rollback(ctx)
	connection, err := s.connections.LockGrantedAgentToolConnectionInTx(ctx, tx, agentActorID, tenantID, connectionID)
	if err != nil {
		return externalsource.AgentToolConnection{}, err
	}
	return connection, tx.Commit(ctx)
}

// failedOrUnknown classifies a provider error. A request the provider refused
// outright did not take effect; anything else may have.
func failedOrUnknown(err error) (string, string, any) {
	if status, ok := composio.ErrorStatus(err); ok && status >= 400 && status < 500 &&
		status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
		return "failed", mapToolError(err, "execute").Message + ".", nil
	}
	return "unknown", "The connected application did not confirm the result.", nil
}

func providerErrorText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return truncate(text, 500)
	}
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	return truncate(string(raw), 500)
}

func (s *Service) checkConnectionActive(ctx context.Context, connection externalsource.AgentToolConnection) error {
	status, err := s.provider.GetConnectionStatusForToolkit(ctx, connection.UpstreamConnectionID, connection.ToolkitSlug)
	if err != nil {
		return mapToolError(&providerOperationError{phase: "connection_status", err: err}, "execute")
	}
	if status != composio.ConnectionActive {
		return mapToolError(externalsource.ErrNotActive, "execute")
	}
	return nil
}

// readTool runs a read-only provider tool and returns its data object.
func (s *Service) readTool(ctx context.Context, connection externalsource.AgentToolConnection, slug, version string, arguments map[string]any) (map[string]any, error) {
	execution, err := s.provider.ExecuteTool(ctx, connection.UpstreamConnectionID, connection.UserID, slug, version, arguments)
	if err != nil {
		return nil, mapToolError(err, "read")
	}
	data, ok := execution.Data.(map[string]any)
	if !execution.Successful || !ok {
		return nil, &Error{Code: "tool_execution_failed", Message: "The connected application did not return the draft"}
	}
	// Some tools wrap their result in their own execution envelope.
	if inner, ok := data["data"].(map[string]any); ok {
		if _, wrapped := data["successful"]; wrapped {
			data = inner
		}
	}
	if inner, ok := data["response_data"].(map[string]any); ok {
		data = inner
	}
	return data, nil
}

func digestOf(value any) string {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

var errDraftUnreadable = errors.New("draft content is unreadable")
