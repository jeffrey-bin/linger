package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ConnectorWriteView is what the sponsor reads on a connector write decision.
// TeamHub builds it from the stored call it will run, so the message is what
// will actually be sent.
type ConnectorWriteView struct {
	// Kind is "message" for mail and chat sends, "change" for the rest.
	Kind    string                 `json:"kind"`
	App     string                 `json:"app"`
	Title   string                 `json:"title"`
	Account string                 `json:"account"`
	Message *ConnectorWriteMessage `json:"message,omitempty"`
	Fields  []ConnectorWriteField  `json:"fields,omitempty"`
	// Tool and Input are the full call: the provider tool slug and its
	// arguments as JSON.
	Tool  string `json:"tool"`
	Input string `json:"input"`
}

// ConnectorWriteMessage is the mail or chat message a write sends, exactly
// as it will be sent.
type ConnectorWriteMessage struct {
	To          []string `json:"to,omitempty"`
	Cc          []string `json:"cc,omitempty"`
	Bcc         []string `json:"bcc,omitempty"`
	Subject     string   `json:"subject,omitempty"`
	Destination string   `json:"destination,omitempty"`
	Body        string   `json:"body"`
	// Format is "html", "markdown", "mrkdwn" (Slack's markup), or "text".
	Format      string   `json:"format"`
	Attachments []string `json:"attachments,omitempty"`
}

// ConnectorWriteField is one target or key value of a change.
type ConnectorWriteField struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// ConnectorWriteRequest is the exact call a connector write decision runs.
type ConnectorWriteRequest struct {
	ConnectionID string          `json:"connection_id"`
	ActionDigest string          `json:"action_digest"`
	Action       json.RawMessage `json:"action"`
}

// ConnectorWriteDecision binds a decision card to the exact call it runs.
type ConnectorWriteDecision struct {
	Request ConnectorWriteRequest
	View    ConnectorWriteView
}

// reusePendingConnectorWrite returns the card of an identical call still
// waiting in this Room, so a repeated command does not post a second card.
// The advisory lock serializes concurrent identical submissions.
func reusePendingConnectorWrite(
	ctx context.Context, tx pgx.Tx, queries *store.Queries,
	tenantID, roomID, agentActorID, actionDigest, alterEgoTaskID string,
) (CreateResult, bool, error) {
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "connector-confirmation|"+agentActorID+"|"+actionDigest); err != nil {
		return CreateResult{}, false, err
	}
	var pending CreateResult
	err := tx.QueryRow(ctx, `SELECT message_id, id FROM decisions
 WHERE tenant_id=$1 AND requested_by_actor_id=$2 AND kind='connector_write' AND request->>'action_digest'=$3
 AND room_id=$4 AND status='pending' AND expires_at>clock_timestamp()
 AND alter_ego_task_id IS NOT DISTINCT FROM $5
 ORDER BY created_at DESC LIMIT 1`, tenantID, agentActorID, actionDigest, roomID, optionalText(alterEgoTaskID)).Scan(&pending.MessageID, &pending.DecisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, false, nil
	}
	if err != nil {
		return CreateResult{}, false, err
	}
	pending.Status, pending.Replay = http.StatusOK, true
	return pending, true, nil
}

func connectorWriteNoticeText(decisionID, title, status, comment string, result decisionStoredResult) string {
	prefix := fmt.Sprintf("Connector confirmation %s (%q): ", decisionID, title)
	switch status {
	case "succeeded":
		text := prefix + "the sponsor approved it and TeamHub ran it."
		if len(result.Data) > 0 && string(result.Data) != "null" {
			text += "\nResult: " + truncateText(string(result.Data), 3000)
		}
		return text
	case "failed":
		return prefix + "the sponsor approved it, but it did not run: " + result.Outcome + "\nNothing was changed by this call."
	case "unknown":
		return prefix + "the sponsor approved it, but its result is unknown: " + result.Outcome + "\nCheck the target before submitting it again."
	case "denied":
		return deniedNotice(prefix+"the sponsor denied it, so it did not run.", comment)
	default:
		return prefix + "nobody decided it before the card expired, so it did not run."
	}
}

func truncateText(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit]) + "…"
}
