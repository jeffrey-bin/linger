package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// RuntimePermissionKind marks the Runtime binding of a permission card. Unlike
// a native question it does not hold the Run: it can be decided after the Run
// ends, and the decision wakes the Agent as an ordinary Inbox message.
const RuntimePermissionKind = "permission"

// runtimePermissionApprovalTTL bounds how long an approved action may wait for
// the Agent's retry.
const runtimePermissionApprovalTTL = 24 * time.Hour

// RuntimePermissionDecision asks the sponsor to approve one action of one
// Context. The approval lets the Agent's next identical retry run once.
type RuntimePermissionDecision struct {
	ContextKey   string
	ActionDigest string
	// Runtime binds the card to the Run that asked.
	Runtime    json.RawMessage
	Card       RuntimePermissionCard
	Screenshot *RuntimePermissionImage
}

// runtimePermissionRequest is what a permission decision stores to match the
// retry that consumes its approval.
type runtimePermissionRequest struct {
	ContextKey   string          `json:"context_key"`
	ActionDigest string          `json:"action_digest"`
	Runtime      json.RawMessage `json:"runtime"`
}

// RuntimePermissionCard is what the approver reads on a permission card. The
// permission review builds it once, when it opens the card.
type RuntimePermissionCard struct {
	// Kind is "gui" for browser and desktop actions, "code" for the rest.
	Kind string `json:"kind"`
	// Title is the action, built by rules from the call and host evidence,
	// never by the judge model.
	Title     string `json:"title"`
	Rationale string `json:"rationale"`
	// Tool and Input are the full call: the shell command, or the native input.
	Tool   string                   `json:"tool"`
	Input  string                   `json:"input"`
	Script *RuntimePermissionScript `json:"script,omitempty"`
	Patch  string                   `json:"patch,omitempty"`
	Page   *RuntimePermissionPage   `json:"page,omitempty"`
	// Screenshot describes the image stored beside the card. The projection
	// adds the URL only the decision owner can read.
	Screenshot *RuntimePermissionScreenshot `json:"screenshot,omitempty"`
}

// RuntimePermissionScreenshot describes the screenshot stored beside a card.
// URL is set only in the decision owner's projection.
type RuntimePermissionScreenshot struct {
	URL    string `json:"url,omitempty"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// RuntimePermissionImage is the screenshot the host captured before a GUI
// action. It is stored with the decision, never in its view.
type RuntimePermissionImage struct {
	MediaType string
	Bytes     []byte
}

// RuntimePermissionScript is the script file a code action would run, shown
// with its body so the approver reads what executes.
type RuntimePermissionScript struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Body   string `json:"body"`
}

// RuntimePermissionPage is the browser page and target element the host
// resolved for a GUI action.
type RuntimePermissionPage struct {
	URL        string `json:"url"`
	Title      string `json:"title,omitempty"`
	TargetRole string `json:"target_role,omitempty"`
	TargetName string `json:"target_name,omitempty"`
}

// runtimePermissionCardView adds the screenshot URL to a stored view.
func runtimePermissionCardView(decisionID string, raw []byte) (json.RawMessage, error) {
	var view RuntimePermissionCard
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, err
	}
	if view.Screenshot != nil {
		view.Screenshot.URL = "/v0/decisions/" + url.PathEscape(decisionID) + "/screenshot"
	}
	return json.Marshal(view)
}

// RuntimePermissionScreenshot reads a permission card's screenshot for its
// decider. Anyone else, and a card without one, gets ErrNotFound.
func (s *Service) RuntimePermissionScreenshot(ctx context.Context, accountID, decisionID string) (string, []byte, error) {
	var mediaType string
	var image []byte
	err := s.pool.QueryRow(ctx, `SELECT decision.screenshot_media_type, decision.screenshot
 FROM decisions decision
 JOIN actors owner ON owner.id=decision.decider_actor_id AND owner.tenant_id=decision.tenant_id
 WHERE decision.id=$1 AND owner.account_id=$2 AND decision.screenshot IS NOT NULL`, decisionID, accountID).Scan(&mediaType, &image)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	return mediaType, image, err
}

// ConsumeRuntimePermission spends one approved, unexpired approval of the
// action and refreshes its card, so the approver sees it was used. It returns
// the card's decision ID, or "" when no approval is available.
func (s *Service) ConsumeRuntimePermission(ctx context.Context, contextKey, digest string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var decisionID, tenantID, agentID, messageID string
	err = tx.QueryRow(ctx, `UPDATE decisions SET status='consumed', finished_at=clock_timestamp()
 WHERE id=(SELECT id FROM decisions
   WHERE kind='runtime_permission' AND request->>'context_key'=$1 AND request->>'action_digest'=$2
     AND status='approved' AND expires_at>clock_timestamp()
   ORDER BY decided_at LIMIT 1 FOR UPDATE SKIP LOCKED)
 RETURNING id, tenant_id, requested_by_actor_id, message_id`, contextKey, digest).Scan(&decisionID, &tenantID, &agentID, &messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err := messagecreation.AdvanceCards(ctx, store.New(tx), tenantID, agentID, []string{messageID}); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return decisionID, nil
}

// runtimeBinding ties a card to the Runtime request that asked for it.
type runtimeBinding struct {
	ContextKey  string `json:"context_key"`
	RunID       string `json:"execution_run_ref"`
	OperationID string `json:"operation_id"`
	RequestID   string `json:"request_id"`
	Kind        string `json:"kind"`
}

// lockRuntimeSource locks the asking Context before Room and card locks,
// matching Local Run terminal commits, and refuses a Run that is no longer
// running. A native question must come from the card's Room Context; a
// permission card may be posted in another Room.
func lockRuntimeSource(ctx context.Context, tx pgx.Tx, roomID, agentID string, data []byte) error {
	var binding runtimeBinding
	if json.Unmarshal(data, &binding) != nil || binding.ContextKey == "" || binding.RunID == "" || binding.OperationID == "" || binding.RequestID == "" {
		return ErrInvalid
	}
	var key string
	err := tx.QueryRow(ctx, `SELECT context.context_key FROM agent_execution_contexts context
 JOIN agent_registrations registration ON registration.actor_id=context.agent_actor_id AND registration.tenant_id=context.tenant_id
 JOIN agent_local_runs run ON run.context_key=context.context_key AND run.run_id=$2
 WHERE context.context_key=$1 AND (context.room_id=$3 OR $5='permission') AND registration.agent_management_id=$4
 AND context.terminal_reason IS NULL
 AND run.status='running' AND NOT run.cancellation_requested
 FOR UPDATE OF context`, binding.ContextKey, binding.RunID, roomID, agentID, binding.Kind).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	return err
}

// requireRuntimeRun refuses an answer to a native question whose Run has
// ended: the answer could no longer reach it.
func requireRuntimeRun(ctx context.Context, tx pgx.Tx, data []byte) error {
	var binding runtimeBinding
	if json.Unmarshal(data, &binding) != nil {
		return ErrInvalid
	}
	var live bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_local_runs run JOIN agent_execution_contexts context USING(context_key)
 WHERE run.run_id=$1 AND run.context_key=$2 AND run.status='running' AND NOT run.cancellation_requested
 AND context.terminal_reason IS NULL)`, binding.RunID, binding.ContextKey).Scan(&live)
	if err != nil {
		return err
	}
	if !live {
		return ErrConflict
	}
	return nil
}

// runtimePermissionNoticeText tells the Agent how its approval card ended.
func runtimePermissionNoticeText(decisionID string, view RuntimePermissionCard, status, comment string) string {
	switch status {
	case "approved", "consumed":
		return fmt.Sprintf("Approval %s was granted: %s\nRetry that call once with exactly the same arguments; this approval covers only that one call.", decisionID, view.Title)
	case "denied":
		return deniedNotice(fmt.Sprintf("Approval %s was denied: %s", decisionID, view.Title), comment)
	default:
		return fmt.Sprintf("Approval %s expired: %s\nNo one acted on it in time, so this call was not approved. Do not bypass the approval another way; do what you can first, and explain in your final reply.", decisionID, view.Title)
	}
}
