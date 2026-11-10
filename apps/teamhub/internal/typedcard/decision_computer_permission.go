package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Computer permission subjects and permissions. Each subject is the app macOS
// grants the permission to: Linger runs shell commands, CuaDriver runs the
// computer-use tools.
const (
	ComputerPermissionSubjectLinger      = "linger"
	ComputerPermissionSubjectComputerUse = "computer_use"

	ComputerPermissionScreenRecording = "screen_recording"
	ComputerPermissionAccessibility   = "accessibility"
)

// ComputerPermissionDecision asks a Local Computer's owner to grant macOS
// permissions to one app on that Computer. The owner grants them on the Mac
// itself; TeamHub answers the card granted once the Computer reports every
// permission granted, or the owner declines it.
type ComputerPermissionDecision struct {
	ComputerID  string
	Subject     string
	Permissions []string
	Reason      string
}

// computerPermissionView is what a computer_permission card shows. The live
// state of each permission is read from the Computer, never stored.
type computerPermissionView struct {
	ComputerID  string   `json:"computer_id"`
	Subject     string   `json:"subject"`
	Permissions []string `json:"permissions"`
	Reason      string   `json:"reason,omitempty"`
}

// computerPermissionTitle is the card's title and Message text; the card names
// the Agent and the rows itself.
const computerPermissionTitle = "System permission needed on your Mac"

func (command ComputerPermissionDecision) normalize() (computerPermissionView, error) {
	view := computerPermissionView{ComputerID: command.ComputerID, Subject: command.Subject, Reason: strings.TrimSpace(command.Reason)}
	if !browserConnectionComputerPattern.MatchString(command.ComputerID) ||
		(command.Subject != ComputerPermissionSubjectLinger && command.Subject != ComputerPermissionSubjectComputerUse) ||
		len(command.Permissions) == 0 || len(command.Permissions) > 2 || utf8.RuneCountInString(view.Reason) > 200 {
		return computerPermissionView{}, ErrInvalid
	}
	for _, permission := range command.Permissions {
		if permission != ComputerPermissionScreenRecording && permission != ComputerPermissionAccessibility ||
			slices.Contains(view.Permissions, permission) {
			return computerPermissionView{}, ErrInvalid
		}
		view.Permissions = append(view.Permissions, permission)
	}
	// One order per set, so a repeated request finds the card still waiting.
	slices.Sort(view.Permissions)
	return view, nil
}

func (command ComputerPermissionDecision) draft() (decisionDraft, error) {
	view, err := command.normalize()
	if err != nil {
		return decisionDraft{}, err
	}
	// The card expires with the window a repeated request reuses it in, so a
	// card nobody granted stops waiting and tells the Agent.
	return decisionDraft{kind: DecisionKindComputerPermission, text: computerPermissionTitle, request: struct{}{},
		view: view, lifetime: connectionAuthorizationTTL, connection: true}, nil
}

// reusePendingComputerPermission returns the card still asking the same owner
// for the same permissions of the same app, so repeated calls do not flood
// the chat.
func reusePendingComputerPermission(
	ctx context.Context, tx pgx.Tx, tenantID, roomID, agentID, humanID string, command ComputerPermissionDecision, alterEgoTaskID string,
) (CreateResult, bool, error) {
	view, err := command.normalize()
	if err != nil {
		return CreateResult{}, false, err
	}
	permissions, err := json.Marshal(view.Permissions)
	if err != nil {
		return CreateResult{}, false, err
	}
	return pendingConnectionCard(ctx, tx, `SELECT message_id,id FROM decisions
 WHERE tenant_id=$1 AND room_id=$2 AND requested_by_actor_id=$3 AND decider_actor_id=$4
 AND kind='computer_permission' AND view->>'computer_id'=$5 AND view->>'subject'=$6
 AND view->'permissions'=$7::jsonb AND status='pending'
 AND created_at>=clock_timestamp()-interval '30 minutes'
 AND alter_ego_task_id IS NOT DISTINCT FROM $8
 ORDER BY created_at DESC LIMIT 1`, tenantID, roomID, agentID, humanID, view.ComputerID, view.Subject, string(permissions), optionalText(alterEgoTaskID))
}

// GrantedComputerPermissions reports whether a subject's permissions are all
// granted on a Computer.
type GrantedComputerPermissions func(subject string, permissions []string) bool

// SettleComputerPermissions answers every pending computer_permission card of
// one owner and Computer whose permissions are all granted, and wakes each
// waiting Agent. Every read of the Computer's permissions calls it, so the
// card settles while the owner is still at their Mac.
func (s *Service) SettleComputerPermissions(ctx context.Context, tenantID, ownerActorID, computerID string, granted GrantedComputerPermissions) error {
	rows, err := s.pool.Query(ctx, `SELECT id,view FROM decisions
 WHERE tenant_id=$1 AND decider_actor_id=$2 AND kind='computer_permission' AND view->>'computer_id'=$3 AND status='pending'`,
		tenantID, ownerActorID, computerID)
	if err != nil {
		return err
	}
	type pendingCard struct {
		ID   string
		View []byte
	}
	cards, err := pgx.CollectRows(rows, pgx.RowToStructByPos[pendingCard])
	if err != nil {
		return err
	}
	var settleErr error
	for _, card := range cards {
		var view computerPermissionView
		if err := json.Unmarshal(card.View, &view); err != nil {
			settleErr = errors.Join(settleErr, err)
			continue
		}
		if !granted(view.Subject, view.Permissions) {
			continue
		}
		settleErr = errors.Join(settleErr, s.settleComputerPermission(ctx, card.ID))
	}
	return settleErr
}

func (s *Service) settleComputerPermission(ctx context.Context, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	live, err := lockDecisionRoomScan(ctx, tx, id)
	if err != nil || !live {
		return err
	}
	var alterEgo bool
	err = tx.QueryRow(ctx, `UPDATE decisions SET status='answered', answer='{"decision":"granted"}'::jsonb,
 decided_at=clock_timestamp(), decided_by_actor_id=decider_actor_id, finished_at=clock_timestamp()
 WHERE id=$1 AND status='pending' RETURNING alter_ego_task_id IS NOT NULL`, id).Scan(&alterEgo)
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

// computerPermissionNoticeText tells the waiting Agent how its permission
// request ended.
func computerPermissionNoticeText(decisionID string, view computerPermissionView, status string) string {
	what := strings.Join(view.Permissions, ", ") + " for " + computerPermissionSubjectLabel(view.Subject)
	switch status {
	case "answered":
		return "Human interaction " + decisionID + " resolved: the user granted " + what + ". Continue the task now."
	case "expired":
		return "Human interaction " + decisionID + " expired: " + what + " was not granted. Continue without it and tell the user what you could not finish."
	}
	return deniedNotice("Human interaction "+decisionID+" resolved: the user declined to grant "+what+". Continue without it and tell the user what you could not finish.", "")
}

func computerPermissionSubjectLabel(subject string) string {
	if subject == ComputerPermissionSubjectComputerUse {
		return "computer use (CuaDriver)"
	}
	return "Linger"
}
