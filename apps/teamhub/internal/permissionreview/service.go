package permissionreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// ErrForbidden means the Context cannot use permission reviews (for example a
// document Context). ErrConflict means the Run is no longer the active
// execution of the Context.
var (
	ErrForbidden = errors.New("permission review is not available for this context")
	ErrConflict  = errors.New("permission review run is not active")
)

// Judge is the model review; Client implements it.
type Judge interface {
	Judge(ctx context.Context, request Request) (Verdict, error)
}

// Cards creates the asynchronous approval card and spends its approval;
// typedcard.Service implements it.
type Cards interface {
	CreateDecision(ctx context.Context, roomID, agentManagementID, idempotencyKey string, requestHash []byte, command typedcard.DecisionCommand) (typedcard.CreateResult, error)
	ConsumeRuntimePermission(ctx context.Context, contextKey, digest string) (string, error)
}

// Service answers one permission review. In order it consumes a matching
// approval, returns a still-pending card, or asks the judge and opens a card
// when the judge needs a human.
type Service struct {
	Pool  *pgxpool.Pool
	Judge Judge
	Cards Cards
	// Timeout bounds the judge, queue wait and its single Runtime attempt
	// included, so the Daemon and Agent Service deadlines above it always see
	// an answer.
	Timeout time.Duration
}

// ReviewInput is the Daemon-assembled request, already decoded.
type ReviewInput struct {
	ContextKey  string
	RunID       string
	OperationID string
	RequestID   string
	Environment Environment
	Action      Action
	Transcript  []TranscriptEntry
	Evidence    Evidence
}

// Outcome is the verdict the Runtime acts on.
type Outcome struct {
	Decision      Decision
	Message       string
	InteractionID string
}

// Messages shown to the Runtime model when the call does not run. The unavailable
// text is kept byte-identical with local-daemon internal/permission/action.go (UnavailableMessage)
// and node-services remote-codex-provider.ts (PERMISSION_REVIEW_UNAVAILABLE).
const (
	approvalMessage    = "This is not a denial. This call needs your sponsor's approval; approval card %s has been sent and is awaiting a decision. Continue with work that does not depend on it; after the approval notice arrives, retry with exactly the same arguments. Do not reach the same effect another way."
	denyMessage        = "This operation was denied by security policy: %s. Do not reach the same effect another way; if it is really needed, explain the reason to the user."
	unavailableMessage = "The permission review service is temporarily unavailable, so this operation did not run. Retry later; do not reach the same effect another way."
)

func (s *Service) Review(ctx context.Context, input ReviewInput) (Outcome, error) {
	if s.Judge == nil {
		// No judge model is configured: the review is off and the Runtime's
		// own rules decide alone, as they did before the review existed.
		return Outcome{Decision: DecisionAllow}, nil
	}
	authority, err := s.loadAuthority(ctx, input)
	if err != nil {
		return Outcome{}, err
	}
	digest := ActionDigest(input.Action, input.Evidence)
	input.Action.Digest = digest

	consumed, err := s.Cards.ConsumeRuntimePermission(ctx, input.ContextKey, digest)
	if err != nil {
		return Outcome{}, err
	}
	if consumed != "" {
		return Outcome{Decision: DecisionAllow, InteractionID: consumed}, nil
	}

	// A pending card is reused only while its approver can still decide it:
	// its Room is not being deleted and the approver is still a member.
	var pending string
	err = s.Pool.QueryRow(ctx, `SELECT decision.id FROM decisions decision
 JOIN rooms room ON room.id=decision.room_id AND room.deletion_started_at IS NULL
 JOIN active_room_members approver ON approver.room_id=decision.room_id AND approver.actor_id=decision.decider_actor_id
 WHERE decision.kind='runtime_permission' AND decision.request->>'context_key'=$1 AND decision.request->>'action_digest'=$2
   AND decision.status='pending' AND (decision.expires_at IS NULL OR decision.expires_at>clock_timestamp())
 ORDER BY decision.created_at DESC LIMIT 1`, input.ContextKey, digest).Scan(&pending)
	if err == nil {
		return Outcome{Decision: DecisionNeedsApproval, InteractionID: pending, Message: fmt.Sprintf(approvalMessage, pending)}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Outcome{}, err
	}

	request := Request{
		Owner:          roomagent.ModelCallOwner{TenantID: authority.tenantID, OwnerActorID: authority.sponsorActorID},
		ContextKey:     input.ContextKey,
		RunOperationID: input.OperationID,
		Environment:    input.Environment,
		Action:         input.Action,
		Transcript:     input.Transcript,
		Evidence:       input.Evidence,
	}
	request.Environment.AgentName = authority.agentName
	request.Environment.ContextKind = authority.kind
	request.Environment.SponsorName = authority.sponsorName
	if request.PriorDecisions, err = s.priorDecisions(ctx, input.ContextKey, digest); err != nil {
		return Outcome{}, err
	}
	if authority.evidenceInbox != "" {
		if request.Authorizations, err = s.authorizations(ctx, authority); err != nil {
			return Outcome{}, err
		}
	}

	judgeCtx, cancel := context.WithTimeout(ctx, s.Timeout)
	verdict, err := s.Judge.Judge(judgeCtx, request)
	cancel()
	if err != nil {
		if ctx.Err() != nil {
			return Outcome{}, ctx.Err()
		}
		slog.WarnContext(ctx, "permission_review.human_fallback", "context_key", input.ContextKey,
			"execution_run_ref", input.RunID, "request_id", input.RequestID, "error", err)
		return s.openCard(ctx, input, authority, digest, Verdict{
			Decision:  DecisionNeedsApproval,
			Rationale: "The automatic permission review is unavailable. Review this exact action before approving it; it has not run.",
		})
	}
	switch verdict.Decision {
	case DecisionAllow:
		return Outcome{Decision: DecisionAllow}, nil
	case DecisionDeny:
		return Outcome{Decision: DecisionDeny, Message: fmt.Sprintf(denyMessage, verdict.Rationale)}, nil
	}
	return s.openCard(ctx, input, authority, digest, verdict)
}

// ActionDigest is the identity an approval binds to: the exact tool call plus
// the content it would run. A changed script or patch is a new action.
func ActionDigest(action Action, evidence Evidence) string {
	canonical := struct {
		Surface   string `json:"surface"`
		Tool      string `json:"tool"`
		Command   string `json:"command"`
		Input     any    `json:"input"`
		Script    string `json:"script"`
		ScriptSHA string `json:"script_sha256"`
		Patch     string `json:"patch"`
	}{Surface: action.Surface, Tool: action.Tool, Command: action.Command, Patch: evidence.Patch}
	// Re-encode the native input so key order and spacing do not matter.
	var input any
	if json.Unmarshal([]byte(action.Input), &input) == nil {
		canonical.Input = input
	} else {
		canonical.Input = action.Input
	}
	if evidence.Script != nil {
		canonical.Script, canonical.ScriptSHA = evidence.Script.Body, evidence.Script.SHA256
	}
	encoded, _ := json.Marshal(canonical)
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:])
}

type authority struct {
	tenantID          string
	agentActorID      string
	agentManagementID string
	agentName         string
	sponsorActorID    string
	sponsorName       string
	kind              string
	cardRoomID        string
	evidenceInbox     string
}

func (s *Service) loadAuthority(ctx context.Context, input ReviewInput) (authority, error) {
	var a authority
	var roomID *string
	var running bool
	// The card goes to the Room the waiting Context answers in: its own Room
	// for a meta, and the Task's origin Room (the creating meta's Room) for an
	// alter_ego. The sponsor's current direct Room is the fallback.
	err := s.Pool.QueryRow(ctx, `SELECT context.tenant_id, context.agent_actor_id, context.agent_management_id,
 agent.display_name, registration.created_by_actor_id, sponsor.display_name, context.context_kind,
 CASE
   WHEN context.context_kind='meta' THEN context.room_id
   WHEN context.context_kind='alter_ego' THEN (SELECT link.room_id FROM work_item_room_links link
     JOIN rooms room ON room.id=link.room_id AND room.tenant_id=link.tenant_id AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
     WHERE link.work_item_id=context.task_id AND link.tenant_id=context.tenant_id AND link.link_type='origin')
 END,
 EXISTS(SELECT 1 FROM agent_local_runs run WHERE run.run_id=$2 AND run.context_key=context.context_key
   AND run.status='running' AND NOT run.cancellation_requested)
 FROM agent_execution_contexts context
 JOIN agent_registrations registration ON registration.actor_id=context.agent_actor_id AND registration.tenant_id=context.tenant_id
 JOIN actors agent ON agent.id=context.agent_actor_id AND agent.tenant_id=context.tenant_id
 JOIN actors sponsor ON sponsor.id=registration.created_by_actor_id AND sponsor.tenant_id=context.tenant_id
 WHERE context.context_key=$1 AND context.terminal_reason IS NULL`,
		input.ContextKey, input.RunID).Scan(&a.tenantID, &a.agentActorID, &a.agentManagementID, &a.agentName,
		&a.sponsorActorID, &a.sponsorName, &a.kind, &roomID, &running)
	if errors.Is(err, pgx.ErrNoRows) {
		return authority{}, ErrConflict
	}
	if err != nil {
		return authority{}, err
	}
	if !running {
		return authority{}, ErrConflict
	}
	if a.kind == "document" {
		return authority{}, ErrForbidden
	}
	if roomID != nil {
		a.cardRoomID = *roomID
	} else if a.cardRoomID, err = s.directRoom(ctx, a); err != nil {
		return authority{}, err
	}
	if a.cardRoomID != "" {
		// The sponsor's instructions for this work are in the Room the card
		// goes to.
		a.evidenceInbox = "room:" + a.cardRoomID
	}
	return a, nil
}

// directRoom is the sponsor's current direct Room with the Agent, or "" when
// they have none.
func (s *Service) directRoom(ctx context.Context, a authority) (string, error) {
	roomID, err := store.New(s.Pool).GetCurrentDirectRoom(ctx, store.GetCurrentDirectRoomParams{
		TenantID: a.tenantID, HumanActorID: a.sponsorActorID, AgentActorID: a.agentActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return roomID, err
}

// Authorization evidence budget: the newest messages first, then oldest
// dropped, so the latest revocation is never the one cut.
const (
	maxAuthorizationMessages = 30
	maxAuthorizationRunes    = 2000
	maxAuthorizationTotal    = 40000
)

func (s *Service) authorizations(ctx context.Context, a authority) ([]AuthorizationMessage, error) {
	rows, err := s.Pool.Query(ctx, `SELECT h.message_id, h.author_actor_id, h.author, h.author_kind, h.body, h.message_kind,
 coalesce(h.source_room_id,''), h.created_at, coalesce(m.fired_routine_id,''), coalesce(m.fired_routine_instruction,'')
 FROM agent_history_messages h
 LEFT JOIN messages m ON h.message_kind='agent_runtime' AND m.id=h.message_id AND m.tenant_id=h.tenant_id
 WHERE h.tenant_id=$1 AND h.inbox_id=$2 AND h.message_kind IN ('conversation','agent_runtime')
 ORDER BY h.source_sequence DESC LIMIT $3`, a.tenantID, a.evidenceInbox, maxAuthorizationMessages)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type firedRoutine struct {
		index             int
		roomID, routineID string
	}
	var newestFirst []AuthorizationMessage
	var routines []firedRoutine
	total := 0
	for rows.Next() {
		var id, authorID, author, authorKind, body, kind, roomID, routineID, instruction string
		var created time.Time
		if err := rows.Scan(&id, &authorID, &author, &authorKind, &body, &kind, &roomID, &created, &routineID, &instruction); err != nil {
			return nil, err
		}
		role := "room_member"
		switch {
		case kind == "agent_runtime":
			// Hidden runtime messages count only as the routine that woke the
			// Agent, posted in the sponsor's name. The scheduler records the
			// origin on the Message; the body is never trusted for it.
			if routineID == "" || authorID != a.sponsorActorID {
				continue
			}
			role, body = "routine", instruction
			routines = append(routines, firedRoutine{index: len(newestFirst), roomID: roomID, routineID: routineID})
		case authorID == a.sponsorActorID:
			role = "sponsor"
		case authorKind == "agent":
			role = "agent"
		}
		body = truncateRunes(body, maxAuthorizationRunes)
		if total += utf8.RuneCountInString(body); total > maxAuthorizationTotal {
			break
		}
		newestFirst = append(newestFirst, AuthorizationMessage{
			ID: id, Author: author, Role: role, CanAuthorize: role == "sponsor",
			At: created.UTC().Format(time.RFC3339Nano), Text: body,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for _, routine := range routines {
		if routine.index >= len(newestFirst) {
			continue
		}
		if newestFirst[routine.index].CanAuthorize, err = s.routineAuthorizes(ctx, a, routine.roomID, routine.routineID); err != nil {
			return nil, err
		}
	}
	messages := make([]AuthorizationMessage, 0, len(newestFirst))
	for index := len(newestFirst) - 1; index >= 0; index-- {
		messages = append(messages, newestFirst[index])
	}
	return messages, nil
}

// routineAuthorizes reports whether a fired routine speaks for the sponsor:
// the sponsor saved it, or the product provisioned it from a template. A
// routine the Agent created for itself stays context only, or an injected
// instruction could later authorize itself.
func (s *Service) routineAuthorizes(ctx context.Context, a authority, roomID, routineID string) (bool, error) {
	var creator string
	var template bool
	err := s.Pool.QueryRow(ctx, `SELECT created_by_actor_id, template_routine_key IS NOT NULL FROM room_reminders
 WHERE tenant_id=$1 AND id=$2 AND room_id=$3`, a.tenantID, routineID, roomID).Scan(&creator, &template)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return creator == a.sponsorActorID || template, nil
}

func (s *Service) priorDecisions(ctx context.Context, contextKey, digest string) ([]PriorDecision, error) {
	rows, err := s.Pool.Query(ctx, `SELECT decision.status, decision.expires_at<=clock_timestamp(),
 coalesce(decision.finished_at, decision.decided_at), coalesce(decider.display_name,''), coalesce(decision.answer->>'comment','')
 FROM decisions decision
 LEFT JOIN actors decider ON decider.id=decision.decider_actor_id AND decider.tenant_id=decision.tenant_id
 WHERE decision.kind='runtime_permission' AND decision.request->>'context_key'=$1 AND decision.request->>'action_digest'=$2
   AND decision.status IN ('approved','denied','consumed')
 ORDER BY coalesce(decision.finished_at, decision.decided_at) DESC LIMIT 5`, contextKey, digest)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var priors []PriorDecision
	for rows.Next() {
		var status, decidedBy, comment string
		var expired *bool
		var at time.Time
		if err := rows.Scan(&status, &expired, &at, &decidedBy, &comment); err != nil {
			return nil, err
		}
		if status == "approved" && expired != nil && *expired {
			status = "expired"
		}
		priors = append(priors, PriorDecision{Digest: digest, Status: status, DecidedBy: decidedBy, At: at.UTC().Format(time.RFC3339Nano), Text: comment})
	}
	return priors, rows.Err()
}

func (s *Service) openCard(ctx context.Context, input ReviewInput, a authority, digest string, verdict Verdict) (Outcome, error) {
	if a.cardRoomID == "" {
		return Outcome{Decision: DecisionUnavailable, Message: unavailableMessage}, nil
	}
	card := Card(input.Action, input.Evidence, input.Environment.Workspace, verdict.Rationale)
	binding, _ := json.Marshal(map[string]any{
		"context_key": input.ContextKey, "execution_run_ref": input.RunID, "operation_id": input.OperationID,
		"request_id": input.RequestID, "kind": typedcard.RuntimePermissionKind,
	})
	identity := sha256.Sum256([]byte(input.ContextKey + "\x00" + input.RunID + "\x00" + input.OperationID + "\x00" + input.RequestID))
	command := typedcard.DecisionCommand{
		DeciderActorID: a.sponsorActorID, RunID: input.RunID,
		RuntimePermission: &typedcard.RuntimePermissionDecision{
			ContextKey: input.ContextKey, ActionDigest: digest, Runtime: binding, Card: card,
			Screenshot: cardImage(input.Evidence.Screenshot),
		},
	}
	key := "runtime-permission-" + hex.EncodeToString(identity[:])
	// The idempotency record stores the raw 32-byte hash of the action.
	requestHash, err := hex.DecodeString(strings.TrimPrefix(digest, "sha256:"))
	if err != nil {
		return Outcome{}, err
	}
	created, err := s.Cards.CreateDecision(ctx, a.cardRoomID, a.agentManagementID, key, requestHash, command)
	if errors.Is(err, typedcard.ErrInvalid) || errors.Is(err, typedcard.ErrNotFound) || errors.Is(err, typedcard.ErrForbidden) {
		// The sponsor, or for a delegated Task the Agent, may no longer be a
		// member of the Room; the direct Room always has both.
		directRoomID, directErr := s.directRoom(ctx, a)
		if directErr != nil {
			return Outcome{}, directErr
		}
		if directRoomID != "" && directRoomID != a.cardRoomID {
			created, err = s.Cards.CreateDecision(ctx, directRoomID, a.agentManagementID, key, requestHash, command)
		}
	}
	if err != nil {
		return Outcome{}, fmt.Errorf("create permission card: %w", err)
	}
	return Outcome{
		Decision: DecisionNeedsApproval, InteractionID: created.DecisionID,
		Message: fmt.Sprintf(approvalMessage, created.DecisionID),
	}, nil
}

func cardImage(screenshot *ScreenshotEvidence) *typedcard.RuntimePermissionImage {
	if screenshot == nil {
		return nil
	}
	return &typedcard.RuntimePermissionImage{MediaType: screenshot.MediaType, Bytes: screenshot.Data}
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}
