package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// connectionAuthorizationTTL is how long a connection authorization card
// waits for the Human's decision, and then for the authorization the Human
// started.
const connectionAuthorizationTTL = 30 * time.Minute

var browserConnectionComputerPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// ConnectionAuthDecision asks a Human to connect a Connected App for the
// requesting Agent. ReusePending answers a repeated request with the card
// still waiting for it.
type ConnectionAuthDecision struct {
	Prompt       string
	AppKey       string
	ReusePending bool
}

// ProviderKeyDecision asks a Human for the deployment's Composio API key,
// which every Connected App needs, so the requesting Agent can then ask to
// connect AppKey. Saving the key answers it, or the Human declines it.
type ProviderKeyDecision struct {
	Prompt string
	AppKey string
}

// BrowserConnectionDecision asks a Local Computer's owner to connect their
// everyday Chrome. TeamHub builds it for an Agent's browser connection
// request; the token never passes through the card. The owner's successful
// connection answers it, or the owner declines it.
type BrowserConnectionDecision struct {
	Prompt     string
	ComputerID string
}

// connectionView is what a connection card shows.
type connectionView struct {
	Prompt     string `json:"prompt"`
	AppKey     string `json:"app_key,omitempty"`
	ComputerID string `json:"computer_id,omitempty"`
}

func normalizeConnectionPrompt(prompt string) (string, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" || utf8.RuneCountInString(prompt) > 2000 {
		return "", ErrInvalid
	}
	return prompt, nil
}

func (command ConnectionAuthDecision) draft() (decisionDraft, error) {
	prompt, err := normalizeConnectionPrompt(command.Prompt)
	appKey := strings.TrimSpace(command.AppKey)
	if err != nil || appKey == "" || utf8.RuneCountInString(appKey) > 120 {
		return decisionDraft{}, ErrInvalid
	}
	return decisionDraft{kind: DecisionKindConnectionAuth, text: prompt, request: struct{}{},
		view: connectionView{Prompt: prompt, AppKey: appKey}, lifetime: connectionAuthorizationTTL, connection: true}, nil
}

func (command ProviderKeyDecision) draft() (decisionDraft, error) {
	prompt, err := normalizeConnectionPrompt(command.Prompt)
	// The app is optional: running a found tool does not say which app it
	// belongs to, and every app needs the same key.
	appKey := strings.TrimSpace(command.AppKey)
	if err != nil || utf8.RuneCountInString(appKey) > 120 {
		return decisionDraft{}, ErrInvalid
	}
	return decisionDraft{kind: DecisionKindProviderKey, text: prompt, request: struct{}{},
		view: connectionView{Prompt: prompt, AppKey: appKey}, connection: true}, nil
}

func (command BrowserConnectionDecision) draft() (decisionDraft, error) {
	prompt, err := normalizeConnectionPrompt(command.Prompt)
	if err != nil || !browserConnectionComputerPattern.MatchString(command.ComputerID) {
		return decisionDraft{}, ErrInvalid
	}
	return decisionDraft{kind: DecisionKindBrowserConnection, text: prompt, request: struct{}{},
		view: connectionView{Prompt: prompt, ComputerID: command.ComputerID}, connection: true}, nil
}

// ConnectionAuthorizer keeps credential and grant policy in External Source.
type ConnectionAuthorizer interface {
	SupportsAgentTools(string) bool
	GrantAgentConnectionInTx(context.Context, pgx.Tx, string, string, string) error
}

// SetConnectionAuthorizer installs External Source's grant policy.
func (s *Service) SetConnectionAuthorizer(authorizer ConnectionAuthorizer) {
	s.connections = authorizer
}

// lockDecisionRoom takes the membership locks before card rows, matching Room
// mutations.
func lockDecisionRoom(ctx context.Context, tx pgx.Tx, roomID string) error {
	queries := store.New(tx)
	_, err := queries.GetRoomTenantID(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID)
}

// lockDecisionRoomScan takes the same locks for a background settlement and
// reports whether the card's Room is still live; deleting Rooms are skipped.
func lockDecisionRoomScan(ctx context.Context, tx pgx.Tx, decisionID string) (bool, error) {
	var roomID string
	err := tx.QueryRow(ctx, `SELECT room_id FROM decisions WHERE id=$1`, decisionID).Scan(&roomID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	queries := store.New(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+roomID); err != nil {
		return false, err
	}
	var live bool
	err = tx.QueryRow(ctx, `SELECT deletion_started_at IS NULL FROM rooms WHERE id=$1`, roomID).Scan(&live)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return live, err
}

func connectionAuthParticipants(ctx context.Context, tx pgx.Tx, tenantID, roomID, humanID, agentID string) (bool, error) {
	var eligible bool
	err := tx.QueryRow(ctx, `SELECT true FROM active_room_members human_member JOIN active_room_members agent_member
		ON agent_member.room_id=human_member.room_id
		JOIN agent_registrations registration ON registration.actor_id=agent_member.actor_id AND registration.tenant_id=agent_member.tenant_id
		WHERE human_member.room_id=$1 AND human_member.tenant_id=$2 AND human_member.actor_id=$3
		AND agent_member.actor_id=$4 AND registration.status='active'
		AND registration.agent_type IN ('anotherme','general') FOR SHARE OF registration`, roomID, tenantID, humanID, agentID).Scan(&eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return eligible, err
}

// reusePendingConnectionAuth admits a connection authorization card and
// returns the card still open for the same app, Human and Agent when the
// command reuses one.
func (s *Service) reusePendingConnectionAuth(
	ctx context.Context, tx pgx.Tx, tenantID, roomID, agentID, humanID string,
	command ConnectionAuthDecision, alterEgoTaskID string,
) (CreateResult, bool, error) {
	appKey := strings.TrimSpace(command.AppKey)
	if s.connections == nil || !s.connections.SupportsAgentTools(appKey) {
		return CreateResult{}, false, ErrInvalid
	}
	eligible, err := connectionAuthParticipants(ctx, tx, tenantID, roomID, humanID, agentID)
	if err != nil {
		return CreateResult{}, false, err
	}
	if !eligible {
		return CreateResult{}, false, ErrForbidden
	}
	if !command.ReusePending {
		return CreateResult{}, false, nil
	}
	return pendingConnectionCard(ctx, tx, `SELECT message_id,id FROM decisions
 WHERE tenant_id=$1 AND room_id=$2 AND requested_by_actor_id=$3 AND decider_actor_id=$4
 AND kind='connection_auth' AND view->>'app_key'=$5 AND status IN ('pending','authorizing')
 AND expires_at>clock_timestamp() AND alter_ego_task_id IS NOT DISTINCT FROM $6
 ORDER BY created_at DESC LIMIT 1`, tenantID, roomID, agentID, humanID, appKey, optionalText(alterEgoTaskID))
}

// reusePendingProviderKey admits a Composio key card and returns the one
// still waiting for the same Human and Agent in this Room: one key serves
// every app.
func reusePendingProviderKey(
	ctx context.Context, tx pgx.Tx, tenantID, roomID, agentID, humanID, alterEgoTaskID string,
) (CreateResult, bool, error) {
	eligible, err := connectionAuthParticipants(ctx, tx, tenantID, roomID, humanID, agentID)
	if err != nil {
		return CreateResult{}, false, err
	}
	if !eligible {
		return CreateResult{}, false, ErrForbidden
	}
	return pendingConnectionCard(ctx, tx, `SELECT message_id,id FROM decisions
 WHERE tenant_id=$1 AND room_id=$2 AND requested_by_actor_id=$3 AND decider_actor_id=$4
 AND kind='provider_key' AND status='pending' AND alter_ego_task_id IS NOT DISTINCT FROM $5
 ORDER BY created_at DESC LIMIT 1`, tenantID, roomID, agentID, humanID, optionalText(alterEgoTaskID))
}

// reusePendingBrowserConnection returns the card still asking the same owner
// to connect the same Computer for this Agent, so repeated browser calls do
// not flood the chat.
func reusePendingBrowserConnection(
	ctx context.Context, tx pgx.Tx, tenantID, roomID, agentID, humanID, computerID, alterEgoTaskID string,
) (CreateResult, bool, error) {
	return pendingConnectionCard(ctx, tx, `SELECT message_id,id FROM decisions
 WHERE tenant_id=$1 AND room_id=$2 AND requested_by_actor_id=$3 AND decider_actor_id=$4
 AND kind='browser_connection' AND view->>'computer_id'=$5 AND status='pending'
 AND created_at>=clock_timestamp()-interval '30 minutes'
 AND alter_ego_task_id IS NOT DISTINCT FROM $6
 ORDER BY created_at DESC LIMIT 1`, tenantID, roomID, agentID, humanID, computerID, optionalText(alterEgoTaskID))
}

func pendingConnectionCard(ctx context.Context, tx pgx.Tx, query string, args ...any) (CreateResult, bool, error) {
	var pending CreateResult
	err := tx.QueryRow(ctx, query, args...).Scan(&pending.MessageID, &pending.DecisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, false, nil
	}
	if err != nil {
		return CreateResult{}, false, err
	}
	pending.Status, pending.Replay = http.StatusOK, true
	return pending, true, nil
}

// beginConnectionAuthorization records the Human's consent to the Connection
// they chose before OAuth completes, and grants it at once when it is
// already active. It never accepts a client-provided "authorized" result.
func (s *Service) beginConnectionAuthorization(ctx context.Context, tx pgx.Tx, authority store.GetDecisionAuthorityRow, connectionID, accountID string) (string, error) {
	var view connectionView
	if err := json.Unmarshal(authority.View, &view); err != nil {
		return "", err
	}
	if s.connections == nil || !s.connections.SupportsAgentTools(view.AppKey) {
		return "", ErrInvalid
	}
	eligible, err := connectionAuthParticipants(ctx, tx, authority.TenantID, authority.RoomID, authority.DeciderActorID, authority.RequestedByActorID)
	if err != nil {
		return "", err
	}
	if !eligible {
		return "", ErrForbidden
	}
	var connectionStatus string
	var reauthorizing bool
	err = tx.QueryRow(ctx, `SELECT status,reauthorization_upstream_id IS NOT NULL FROM external_connections
 WHERE id=$1 AND account_id=$2 AND provider=$3 FOR SHARE`, connectionID, accountID, view.AppKey).Scan(&connectionStatus, &reauthorizing)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrForbidden
	}
	if err != nil {
		return "", err
	}
	switch {
	case connectionStatus == "active":
		if err := s.connections.GrantAgentConnectionInTx(ctx, tx, accountID, connectionID, authority.RequestedByActorID); err != nil {
			return "", err
		}
		return "succeeded", nil
	case connectionStatus == "pending" || reauthorizing:
		return "authorizing", nil
	default:
		return "", ErrConflict
	}
}

// SettleConnectionAuthorizations settles the cards waiting on a Connection that
// just became active.
func (s *Service) SettleConnectionAuthorizations(ctx context.Context, connectionID string) error {
	return s.settleConnectionAuthorizations(ctx, `SELECT id FROM decisions
 WHERE kind='connection_auth' AND status='authorizing' AND answer->>'connection_id'=$1 ORDER BY id`, connectionID)
}

// ReconcileConnectionAuthorizations is the safety net for cards whose
// settlement was lost: the OAuth completes outside any decision, so only a
// scan finds a lost one. The connection_auth_reconcile job runs it every
// minute. Recorded consent and locked decision rows make restart and duplicate
// delivery safe.
func (s *Service) ReconcileConnectionAuthorizations(ctx context.Context) error {
	return s.settleConnectionAuthorizations(ctx, `SELECT decision.id FROM decisions decision
 JOIN rooms room ON room.id=decision.room_id AND room.deletion_started_at IS NULL
 WHERE decision.kind='connection_auth' AND decision.status IN ('pending','authorizing')
 AND (decision.status='authorizing' OR decision.expires_at<=clock_timestamp())
 ORDER BY decision.decided_at NULLS FIRST,decision.id LIMIT 100`)
}

func (s *Service) settleConnectionAuthorizations(ctx context.Context, query string, args ...any) error {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var failures error
	for _, id := range ids {
		failures = errors.Join(failures, s.settleConnectionAuthorization(ctx, id))
	}
	return failures
}

// settleConnectionAuthorization ends one open card whose deadline passed or
// whose Connection became active or unusable, and tells its Agent.
func (s *Service) settleConnectionAuthorization(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	live, err := lockDecisionRoomScan(ctx, tx, id)
	if err != nil || !live {
		return err
	}
	var tenantID, roomID, humanID, agentID, accountID, status, connectionID string
	var viewJSON []byte
	var due, alterEgo bool
	err = tx.QueryRow(ctx, `SELECT decision.tenant_id,decision.room_id,decision.decider_actor_id,decision.requested_by_actor_id,
 coalesce(human.account_id,''),decision.status,decision.view,coalesce(decision.answer->>'connection_id',''),
 decision.expires_at<=clock_timestamp(),decision.alter_ego_task_id IS NOT NULL
 FROM decisions decision JOIN actors human ON human.id=decision.decider_actor_id AND human.tenant_id=decision.tenant_id
 WHERE decision.id=$1 AND decision.status IN ('pending','authorizing') FOR UPDATE OF decision SKIP LOCKED`, id).Scan(
		&tenantID, &roomID, &humanID, &agentID, &accountID, &status, &viewJSON, &connectionID, &due, &alterEgo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var view connectionView
	if err := json.Unmarshal(viewJSON, &view); err != nil {
		return err
	}
	next := ""
	switch {
	case due:
		next = "expired"
	case status == "authorizing":
		eligible, err := connectionAuthParticipants(ctx, tx, tenantID, roomID, humanID, agentID)
		if err != nil {
			return err
		}
		if !eligible || s.connections == nil || !s.connections.SupportsAgentTools(view.AppKey) {
			next = "failed"
			break
		}
		var current string
		var reauthorizing bool
		err = tx.QueryRow(ctx, `SELECT status,reauthorization_upstream_id IS NOT NULL FROM external_connections
 WHERE id=$1 AND account_id=$2 AND provider=$3 FOR SHARE`, connectionID, accountID, view.AppKey).Scan(&current, &reauthorizing)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			next = "failed"
		case err != nil:
			return err
		case current == "active":
			if err := s.connections.GrantAgentConnectionInTx(ctx, tx, accountID, connectionID, agentID); err != nil {
				return err
			}
			next = "succeeded"
		case current != "pending" && !reauthorizing:
			next = "failed"
		}
	}
	if next == "" {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE decisions SET status=$2, finished_at=clock_timestamp() WHERE id=$1`, id, next); err != nil {
		return err
	}
	if err := endSettledDecision(ctx, tx, id, alterEgo); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// endSettledDecision hands off a decision a background settlement or its
// expiry ended: a Room Agent hears in this transaction, while waking a
// delegated Task's AlterEgo locks the Task, which must not follow the Room
// locks the handoff takes, so the run job does it.
func endSettledDecision(ctx context.Context, tx pgx.Tx, id string, alterEgo bool) error {
	if alterEgo {
		return jobs.InsertTx(ctx, tx, jobs.DecisionRunArgs{DecisionID: id}, nil)
	}
	_, err := handOffDecisionInTx(ctx, tx, id)
	return err
}

// SettleBrowserConnections answers every pending browser connection card of
// one owner and Computer once that owner's Chrome is connected, and wakes
// each waiting Agent. The browser connection handler calls it after the Computer
// confirmed the connection.
func (s *Service) SettleBrowserConnections(ctx context.Context, tenantID, ownerActorID, computerID string) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM decisions
 WHERE tenant_id=$1 AND decider_actor_id=$2 AND kind='browser_connection' AND view->>'computer_id'=$3 AND status='pending'`,
		tenantID, ownerActorID, computerID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var settleErr error
	for _, id := range ids {
		settleErr = errors.Join(settleErr, s.settleBrowserConnection(ctx, id))
	}
	return settleErr
}

func (s *Service) settleBrowserConnection(ctx context.Context, id string) error {
	return s.answerConnectionCard(ctx, id, "connected")
}

// SettleProviderKeys answers every pending Composio key card once a key is
// saved, and wakes each waiting Agent. The key belongs to the deployment, so
// it answers the cards of every tenant.
func (s *Service) SettleProviderKeys(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM decisions WHERE kind='provider_key' AND status='pending' ORDER BY id`)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var settleErr error
	for _, id := range ids {
		settleErr = errors.Join(settleErr, s.answerConnectionCard(ctx, id, "configured"))
	}
	return settleErr
}

// answerConnectionCard answers one pending card on its decider's behalf with
// what happened outside it, and hands the answer to its Agent.
func (s *Service) answerConnectionCard(ctx context.Context, id, decision string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	live, err := lockDecisionRoomScan(ctx, tx, id)
	if err != nil || !live {
		return err
	}
	answer, err := json.Marshal(decisionAnswer{Decision: decision})
	if err != nil {
		return err
	}
	var alterEgo bool
	err = tx.QueryRow(ctx, `UPDATE decisions SET status='answered', answer=$2::jsonb,
 decided_at=clock_timestamp(), decided_by_actor_id=decider_actor_id, finished_at=clock_timestamp()
 WHERE id=$1 AND status='pending' RETURNING alter_ego_task_id IS NOT NULL`, id, answer).Scan(&alterEgo)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := endSettledDecision(ctx, tx, id, alterEgo); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// connectionCardView is the kind's view on a connection card. The Connection
// a Human chose is read back only from the stored answer.
func connectionCardView(kind string, view connectionView, rawAnswer []byte) (json.RawMessage, json.RawMessage, error) {
	if kind == DecisionKindBrowserConnection {
		encoded, err := json.Marshal(struct {
			ComputerID string `json:"computer_id"`
		}{view.ComputerID})
		return nil, encoded, err
	}
	var answer decisionAnswer
	if len(rawAnswer) > 0 {
		if err := json.Unmarshal(rawAnswer, &answer); err != nil {
			return nil, nil, err
		}
	}
	encoded, err := json.Marshal(struct {
		AppKey       string `json:"app_key"`
		ConnectionID string `json:"connection_id,omitempty"`
	}{view.AppKey, answer.ConnectionID})
	return encoded, nil, err
}

// connectionAuthNoticeText tells the requesting Agent how its connection
// authorization ended. A Room Agent reads the decision as a payload.
func connectionAuthNoticeText(decisionID string, view connectionView, status string, answer decisionAnswer, alterEgo bool) string {
	payload := connectionAuthPayload{Decision: "deny"}
	switch status {
	case "succeeded":
		payload = connectionAuthPayload{Decision: "approve", ConnectionID: answer.ConnectionID}
	case "failed", "expired":
		payload.Comment = "Connection authorization " + status
	}
	if !alterEgo {
		encoded, _ := json.Marshal(payload)
		return "Human interaction " + decisionID + " payload=" + string(encoded)
	}
	if status == "succeeded" {
		return "The Sponsor connected " + view.AppKey + ". Run the command that needed it again."
	}
	if status == "denied" {
		status = "failed"
	}
	text := "The " + view.AppKey + " connection was not completed (" + status + "). Commands that need it still fail; continue without it and say so in your final reply."
	if payload.Comment != "" {
		text += "\n" + payload.Comment
	}
	return text
}

// connectionAuthPayload is how a Room Agent reads a connection
// authorization's result.
type connectionAuthPayload struct {
	Decision     string `json:"decision"`
	ConnectionID string `json:"connection_id,omitempty"`
	Comment      string `json:"comment,omitempty"`
}

// providerKeyNoticeText tells the requesting Agent whether the Composio key
// it asked for was added.
func providerKeyNoticeText(decisionID string, view connectionView, status string, alterEgo bool) string {
	who, prefix := "the user", "Human interaction "+decisionID+" resolved: "
	if alterEgo {
		who, prefix = "The Sponsor", ""
	}
	if status == "answered" {
		if view.AppKey == "" {
			return prefix + who + " added the Composio API key. Run the command that needed it again; it asks to connect the app if no account is connected yet."
		}
		return prefix + who + " added the Composio API key. Run the command that needed " + view.AppKey +
			" again; it asks to connect " + view.AppKey + " if no account is connected yet."
	}
	return prefix + who + " did not add the Composio API key, so every connected app stays unavailable. Do not ask again for this task; continue without it and say so."
}

// browserConnectionNoticeText tells the waiting Agent what the owner did.
func browserConnectionNoticeText(decisionID, status string) string {
	if status == "answered" {
		return "Human interaction " + decisionID + " resolved: the user connected their everyday Chrome. Continue the browser task now."
	}
	return "Human interaction " + decisionID + " resolved: the user declined to connect their everyday Chrome. Do not retry browser tools for this task; tell them what you could not finish."
}
