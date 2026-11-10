package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Decision kinds. Each kind stores its own request and view. A Connector
// write and an Agent change run an executor once approved; a Runtime
// permission's approval is spent by the Agent's retry; a question and the
// AnotherMe setup cards end with their answer. A connection authorization
// ends when the OAuth the Human started completes, a Composio key request
// when someone saves the key, a browser connection when
// the owner connects Chrome, and a computer permission when the Computer
// reports its permissions granted; a Room creation runs in its decision; a
// Document access card follows the Document access request it shows.
const (
	DecisionKindConnectorWrite      = "connector_write"
	DecisionKindAgentChange         = "agent_change"
	DecisionKindQuestion            = "question"
	DecisionKindRuntimePermission   = "runtime_permission"
	DecisionKindProfileSetupApps    = "profile_setup_apps"
	DecisionKindProfileSetupSources = "profile_setup_sources"
	DecisionKindConnectionAuth      = "connection_auth"
	DecisionKindProviderKey         = "provider_key"
	DecisionKindBrowserConnection   = "browser_connection"
	DecisionKindRoomCreation        = "room_creation"
	DecisionKindComputerPermission  = "computer_permission"
)

// decisionTTL bounds how long a Connector write or Agent change waits for its
// Human; an undecided card then expires without running. A delegated Task's
// AlterEgo waits only alterEgoApprovalTTL. Questions and Room permission
// cards wait until they are answered.
const decisionTTL = 24 * time.Hour

// decisionRuns reports whether an approved decision of the kind runs an
// executor.
func decisionRuns(kind string) bool {
	return kind == DecisionKindConnectorWrite || kind == DecisionKindAgentChange
}

// DecisionCommand opens a decision card for one Human in a Room.
type DecisionCommand struct {
	Principal      *agentcredential.Principal
	DeciderActorID string
	// RunID is the Local Run that asked, recorded on the card Message so the
	// Run's reply obligations wait for the decision.
	RunID string
	// AlterEgoTaskID is set when a delegated Task's AlterEgo asked: the result
	// then wakes that Task instead of @mentioning the Agent in the Room. A
	// permission card of an AlterEgo Context sets it from the Context.
	AlterEgoTaskID string
	// Exactly one kind is set.
	ConnectorWrite     *ConnectorWriteDecision
	AgentChange        *AgentChangeDecision
	Question           *QuestionDecision
	RuntimePermission  *RuntimePermissionDecision
	ConnectionAuth     *ConnectionAuthDecision
	ProviderKey        *ProviderKeyDecision
	BrowserConnection  *BrowserConnectionDecision
	ComputerPermission *ComputerPermissionDecision
}

// decisionDraft is a command's card before it is stored.
type decisionDraft struct {
	kind string
	// text follows the decider's mention in the card Message.
	text          string
	request, view any
	runtime       json.RawMessage
	lifetime      time.Duration
	screenshot    *RuntimePermissionImage
	// connection kinds keep their own lifetime for a delegated Task's
	// AlterEgo and are posted under the Room membership lock.
	connection bool
}

func (command DecisionCommand) draft() (decisionDraft, error) {
	set := 0
	for _, present := range []bool{command.ConnectorWrite != nil, command.AgentChange != nil, command.Question != nil,
		command.RuntimePermission != nil, command.ConnectionAuth != nil, command.ProviderKey != nil,
		command.BrowserConnection != nil, command.ComputerPermission != nil} {
		if present {
			set++
		}
	}
	if set != 1 {
		return decisionDraft{}, ErrInvalid
	}
	switch {
	case command.ConnectorWrite != nil:
		write := command.ConnectorWrite
		return decisionDraft{kind: DecisionKindConnectorWrite, text: "Approval needed: " + write.View.Title,
			request: write.Request, view: write.View, lifetime: decisionTTL}, nil
	case command.AgentChange != nil:
		change := command.AgentChange
		if (change.View.Action == "update") != (change.Request.TargetActorID != "") || len(change.View.Changes) == 0 {
			return decisionDraft{}, ErrInvalid
		}
		return decisionDraft{kind: DecisionKindAgentChange, text: "Approval needed: " + agentChangeTitle(change.View),
			request: change.Request, view: change.View, lifetime: decisionTTL}, nil
	case command.Question != nil:
		question := command.Question
		prompt, err := normalizePrompt(question.Prompt)
		if err != nil {
			return decisionDraft{}, err
		}
		questions, err := normalizeQuestions(question.Questions)
		if err != nil {
			return decisionDraft{}, err
		}
		return decisionDraft{kind: DecisionKindQuestion, text: prompt, runtime: question.Runtime,
			request: decisionRuntimeRequest{Runtime: question.Runtime}, view: questionView{Prompt: prompt, Questions: questions}}, nil
	case command.ConnectionAuth != nil:
		return command.ConnectionAuth.draft()
	case command.ProviderKey != nil:
		return command.ProviderKey.draft()
	case command.BrowserConnection != nil:
		return command.BrowserConnection.draft()
	case command.ComputerPermission != nil:
		return command.ComputerPermission.draft()
	default:
		permission := command.RuntimePermission
		if permission.ContextKey == "" || permission.ActionDigest == "" || len(permission.Runtime) == 0 || strings.TrimSpace(permission.Card.Title) == "" {
			return decisionDraft{}, ErrInvalid
		}
		return decisionDraft{kind: DecisionKindRuntimePermission, text: "Approval needed: " + permission.Card.Title,
			runtime: permission.Runtime, screenshot: permission.Screenshot,
			request: runtimePermissionRequest{ContextKey: permission.ContextKey, ActionDigest: permission.ActionDigest, Runtime: permission.Runtime},
			view:    permission.Card}, nil
	}
}

// DecisionExecutor runs what an approved decision of one kind allows.
type DecisionExecutor struct {
	// Rerun declares how a run that stopped midway ends. true: the run is
	// idempotent per decision and runs again on retry. false: the run may have
	// taken effect, so the decision ends unknown and never runs again.
	Rerun bool
	// Run runs the approved request. An error retries the job, which then
	// applies Rerun.
	Run func(ctx context.Context, decision ClaimedDecision) (DecisionResult, error)
}

// ClaimedDecision is an approved decision its executor runs.
type ClaimedDecision struct {
	ID, Kind, TenantID, RoomID string
	RequestedByActorID         string
	DeciderActorID             string
	Request                    json.RawMessage
}

// DecisionResult is how a run ended.
type DecisionResult struct {
	// Status is succeeded, failed (it did not take effect), or unknown.
	Status  string
	Outcome string
	// Data is what the requesting Agent reads about the result.
	Data any
	// Announce, when set, runs in the transaction that records the result,
	// so a retried job announces once.
	Announce func(ctx context.Context, queries *store.Queries) error
}

// RegisterDecisionExecutor installs the executor of one kind. The app
// registers every executor before its job workers start.
func (s *Service) RegisterDecisionExecutor(kind string, executor DecisionExecutor) {
	if s.executors == nil {
		s.executors = map[string]DecisionExecutor{}
	}
	s.executors[kind] = executor
}

// DecisionExpireArgs expires a decision nobody made. It is scheduled for the
// card's expiry when the card is created.
type DecisionExpireArgs struct {
	DecisionID string `json:"decision_id"`
}

// Kind names the job.
func (DecisionExpireArgs) Kind() string { return "decision.expire" }

// InsertOpts retries a failed notice.
func (DecisionExpireArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 5}
}

// CreateDecision posts a decision card for the command's Human. A retried
// operation replays its card; an identical connector write still pending in
// the Room reuses its card.
func (s *Service) CreateDecision(
	ctx context.Context,
	roomID, agentManagementID, idempotencyKey string,
	requestHash []byte,
	command DecisionCommand,
) (CreateResult, error) {
	draft, err := command.draft()
	if err != nil {
		return CreateResult{}, err
	}
	if permission := command.RuntimePermission; permission != nil {
		if ref, err := agentruntimestate.DecodeContextKey(permission.ContextKey); err == nil && ref.Kind == "alter_ego" {
			command.AlterEgoTaskID = ref.TaskID
		}
	}
	if command.AlterEgoTaskID != "" && !draft.connection {
		draft.lifetime = alterEgoApprovalTTL
	}
	requestJSON, err := json.Marshal(draft.request)
	if err != nil {
		return CreateResult{}, err
	}
	viewJSON, err := json.Marshal(draft.view)
	if err != nil {
		return CreateResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateResult{}, err
	}
	defer tx.Rollback(ctx)
	// A pending connection card is reused, so its lookup and insert run under
	// the Room membership lock.
	if draft.connection {
		if err := lockDecisionRoom(ctx, tx, roomID); err != nil {
			return CreateResult{}, err
		}
	}
	if len(draft.runtime) > 0 {
		if err := lockRuntimeSource(ctx, tx, roomID, agentManagementID, draft.runtime); err != nil {
			return CreateResult{}, err
		}
	}
	operation := "createAgentMessage:" + roomID
	authority, replay, found, err := lockCreateReplayByRoomAgent(ctx, tx, roomID, agentManagementID, operation, idempotencyKey, requestHash)
	if err != nil {
		return CreateResult{}, err
	}
	if p := command.Principal; p != nil {
		if p.AgentID != agentManagementID ||
			(!found && (p.AgentActorID != authority.AgentID || p.TenantID != authority.TenantID)) {
			return CreateResult{}, ErrForbidden
		}
		// Admission committed before this transaction. Recheck after the Room
		// and operation locks, then hold credential validity through the write.
		if err := agentcredential.RevalidateInTx(ctx, tx, *p); err != nil {
			if errors.Is(err, agentcredential.ErrInvalid) {
				return CreateResult{}, ErrForbidden
			}
			return CreateResult{}, err
		}
	}
	if found {
		if replay.DecisionID, err = decisionOfMessage(ctx, tx, replay.MessageID); err != nil {
			return CreateResult{}, err
		}
		return replay, tx.Commit(ctx)
	}
	queries := store.New(tx)
	author := actorFromRoomAgent(authority)
	decider, err := queries.GetHumanRoomMemberActor(ctx, store.GetHumanRoomMemberActorParams{
		RoomID: authority.RoomID, ActorID: command.DeciderActorID, TenantID: authority.TenantID, Kind: "human",
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrAssigneeNotMember
	}
	if err != nil {
		return CreateResult{}, err
	}
	// A repeated request reuses the card still waiting for it instead of
	// flooding the chat.
	var pending CreateResult
	switch {
	case command.ConnectorWrite != nil:
		pending, found, err = reusePendingConnectorWrite(ctx, tx, queries, authority.TenantID, authority.RoomID, author.ID, command.ConnectorWrite.Request.ActionDigest, command.AlterEgoTaskID)
	case command.ConnectionAuth != nil:
		pending, found, err = s.reusePendingConnectionAuth(ctx, tx, authority.TenantID, authority.RoomID, author.ID, decider.ID, *command.ConnectionAuth, command.AlterEgoTaskID)
	case command.ProviderKey != nil:
		pending, found, err = reusePendingProviderKey(ctx, tx, authority.TenantID, authority.RoomID, author.ID, decider.ID, command.AlterEgoTaskID)
	case command.BrowserConnection != nil:
		pending, found, err = reusePendingBrowserConnection(ctx, tx, authority.TenantID, authority.RoomID, author.ID, decider.ID, command.BrowserConnection.ComputerID, command.AlterEgoTaskID)
	case command.ComputerPermission != nil:
		pending, found, err = reusePendingComputerPermission(ctx, tx, authority.TenantID, authority.RoomID, author.ID, decider.ID, *command.ComputerPermission, command.AlterEgoTaskID)
	}
	if err != nil {
		return CreateResult{}, err
	}
	if found {
		return pending, tx.Commit(ctx)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "reference", Content: messagecreation.MentionToken(decider.DisplayName), Target: decider.ID, TargetType: "user"},
		{Type: "text", Content: " " + draft.text},
	})
	if err != nil {
		return CreateResult{}, err
	}
	message, err := messagecreation.Persist(ctx, queries, messagecreation.Draft{
		TenantID: authority.TenantID, RoomID: authority.RoomID, Author: author, Content: content,
		Mentions: []store.Actor{decider},
		Card: &messagecreation.Card{
			DecisionOwnerActorID: decider.ID, CardType: "personal_notice", Intent: "decision_requested",
		},
		TrustedRunID: command.RunID,
	})
	if err != nil {
		return CreateResult{}, err
	}
	insert := store.InsertDecisionParams{
		ID: idgen.New("decision"), TenantID: authority.TenantID, RoomID: authority.RoomID, MessageID: message.Message.ID,
		Kind: draft.kind, RequestedByActorID: author.ID, DeciderActorID: decider.ID,
		AlterEgoTaskID: optionalText(command.AlterEgoTaskID), Request: requestJSON, View: viewJSON,
		LifetimeSeconds: draft.lifetime.Seconds(),
	}
	if image := draft.screenshot; image != nil {
		insert.Screenshot, insert.ScreenshotMediaType = image.Bytes, optionalText(image.MediaType)
	}
	expiresAt, err := queries.InsertDecision(ctx, insert)
	if err != nil {
		return CreateResult{}, err
	}
	if expiresAt.Valid {
		if err := jobs.InsertTx(ctx, tx, DecisionExpireArgs{DecisionID: insert.ID}, &river.InsertOpts{ScheduledAt: expiresAt.Time}); err != nil {
			return CreateResult{}, err
		}
	}
	published, err := publishCardMessage(ctx, queries, message)
	if err != nil {
		return CreateResult{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AgentKey(author.ID, operation, idempotencyKey), requestHash,
		idempotency.Record{ResourceID: published.Message.ID, Status: http.StatusCreated, Body: published.Payload}); err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{
		Status: http.StatusCreated, Body: published.Payload, MessageID: published.Message.ID, DecisionID: insert.ID,
	}, nil
}

func decisionOfMessage(ctx context.Context, tx pgx.Tx, messageID string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM decisions WHERE message_id=$1`, messageID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrIdempotencyConflict
	}
	return id, err
}

func optionalText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

// DecisionAnswerCommand answers a decision with the fields its kind takes:
// approve or deny with an optional reason for a denial (a Room creation's
// denial requires one), approve with the chosen Connection or deny for a
// connection authorization, deny for a browser connection or a computer
// permission, submit with
// answers and an optional note for a question, connected or skipped for the
// apps card, and done or skipped with links and uploads for the sources card.
type DecisionAnswerCommand struct {
	ExpectedVersion     int64
	Decision            string
	Comment             string
	ConnectionID        string
	Answers             map[string]any
	Links               []string
	AttachmentUploadIDs []string
}

// decisionAnswer is the stored answer.
type decisionAnswer struct {
	Decision            string         `json:"decision"`
	Comment             string         `json:"comment,omitempty"`
	ConnectionID        string         `json:"connection_id,omitempty"`
	Answers             map[string]any `json:"answers,omitempty"`
	Links               []string       `json:"links,omitempty"`
	AttachmentUploadIDs []string       `json:"attachment_upload_ids,omitempty"`
}

// normalizeDecisionAnswer checks an answer against its kind and names the
// status it records.
func normalizeDecisionAnswer(kind string, view []byte, command DecisionAnswerCommand) (decisionAnswer, string, error) {
	command.Comment = strings.TrimSpace(command.Comment)
	if utf8.RuneCountInString(command.Comment) > 10000 ||
		kind != DecisionKindQuestion && len(command.Answers) > 0 ||
		kind != DecisionKindConnectionAuth && command.ConnectionID != "" ||
		kind != DecisionKindProfileSetupSources && (len(command.Links) > 0 || len(command.AttachmentUploadIDs) > 0) {
		return decisionAnswer{}, "", ErrInvalid
	}
	switch kind {
	case DecisionKindQuestion:
		var stored questionView
		if err := json.Unmarshal(view, &stored); err != nil {
			return decisionAnswer{}, "", err
		}
		if command.Decision != "submit" {
			return decisionAnswer{}, "", ErrInvalid
		}
		answers, err := normalizeQuestionAnswers(stored.Questions, command.Answers)
		if err != nil {
			return decisionAnswer{}, "", err
		}
		return decisionAnswer{Decision: "submit", Comment: command.Comment, Answers: answers}, "answered", nil
	case DecisionKindProfileSetupApps:
		if command.Decision != "connected" && command.Decision != "skipped" || command.Comment != "" {
			return decisionAnswer{}, "", ErrInvalid
		}
		return decisionAnswer{Decision: command.Decision}, "answered", nil
	case DecisionKindProfileSetupSources:
		if command.Comment != "" {
			return decisionAnswer{}, "", ErrInvalid
		}
		answer, err := normalizeProfileSourcesAnswer(command)
		return answer, "answered", err
	case DecisionKindConnectionAuth:
		// The status is the authorization's, which apply works out.
		if command.Decision != "approve" && command.Decision != "deny" || command.Comment != "" ||
			(command.Decision == "approve") != (command.ConnectionID != "") || len(command.ConnectionID) > 128 {
			return decisionAnswer{}, "", ErrInvalid
		}
		return decisionAnswer{Decision: command.Decision, ConnectionID: command.ConnectionID}, "denied", nil
	case DecisionKindProviderKey, DecisionKindBrowserConnection, DecisionKindComputerPermission:
		// Only a saved Composio key, the owner's own connection, or the
		// Computer's report that every permission is granted answers the card
		// otherwise.
		if command.Decision != "deny" || command.Comment != "" {
			return decisionAnswer{}, "", ErrInvalid
		}
		return decisionAnswer{Decision: "deny"}, "denied", nil
	case DecisionKindRoomCreation:
		if command.Decision == "approve" && command.Comment == "" {
			return decisionAnswer{Decision: "approve"}, "succeeded", nil
		}
		if command.Decision != "deny" || command.Comment == "" {
			return decisionAnswer{}, "", ErrInvalid
		}
		return decisionAnswer{Decision: "deny", Comment: command.Comment}, "denied", nil
	default:
		if command.Decision != "approve" && command.Decision != "deny" || command.Decision == "approve" && command.Comment != "" {
			return decisionAnswer{}, "", ErrInvalid
		}
		status := "denied"
		if command.Decision == "approve" {
			status = "approved"
		}
		return decisionAnswer{Decision: command.Decision, Comment: command.Comment}, status, nil
	}
}

// DecideDecision records the decision owner's answer. An approved Connector
// write or Agent change runs, and its Agent hears the result, in the
// decision.run job; every other answer reaches its Agent in this transaction,
// or through that job for a delegated Task's AlterEgo.
func (s *Service) DecideDecision(
	ctx context.Context,
	accountID, decisionID string,
	command DecisionAnswerCommand,
) (CreateResult, error) {
	if command.ExpectedVersion < 1 {
		return CreateResult{}, ErrInvalid
	}
	return s.decideCard(ctx, &decisionAnswerStep{
		service: s, id: decisionID, command: command, accountID: accountID,
	})
}

// decisionAnswerStep is an answer decideCard records.
type decisionAnswerStep struct {
	service   *Service
	id        string
	command   DecisionAnswerCommand
	accountID string
	authority store.GetDecisionAuthorityRow
}

// authorize lets any member of the card's Room see the card; only its
// decision owner decides it, or any member a Room creation that an Agent
// visible to the whole workspace asked for.
// It locks the decision and card rows and returns ErrNotFound for a caller who
// cannot see the card, ErrForbidden for one who may not decide it.
func (d *decisionAnswerStep) authorize(ctx context.Context, queries *store.Queries) error {
	authority, err := queries.GetDecisionAuthority(ctx, store.GetDecisionAuthorityParams{AccountID: d.accountID, DecisionID: d.id})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if authority.CallerActorID != authority.DeciderActorID &&
		(authority.Kind != DecisionKindRoomCreation || authority.RequesterVisibilityScope != "workspace") {
		return ErrForbidden
	}
	d.authority = authority
	return nil
}

// apply refuses an answer the card no longer takes, records it, and hands it
// off as its kind does.
func (d *decisionAnswerStep) apply(ctx context.Context, tx pgx.Tx, queries *store.Queries) (decisionOutcome, error) {
	authority := d.authority
	var runtime decisionRuntimeRequest
	if err := json.Unmarshal(authority.Request, &runtime); err != nil {
		return decisionOutcome{}, err
	}
	// A native question's answer must still reach its Run; a permission card
	// outlives the Run that asked.
	if authority.Kind == DecisionKindQuestion && len(runtime.Runtime) > 0 {
		if err := requireRuntimeRun(ctx, tx, runtime.Runtime); err != nil {
			return decisionOutcome{}, err
		}
	}
	// An authorization in progress can only be cancelled.
	if authority.CardVersion != d.command.ExpectedVersion || !authority.Open ||
		authority.Status == "authorizing" && d.command.Decision != "deny" {
		return decisionOutcome{}, ErrConflict
	}
	answer, status, err := normalizeDecisionAnswer(authority.Kind, authority.View, d.command)
	if err != nil {
		return decisionOutcome{}, err
	}
	encoded, err := json.Marshal(answer)
	if err != nil {
		return decisionOutcome{}, err
	}
	// lifetime restarts the card's clock at the decision: an approved Runtime
	// permission lapses, an authorization in progress expires.
	var lifetime float64
	switch {
	case authority.Kind == DecisionKindRuntimePermission && status == "approved":
		lifetime = runtimePermissionApprovalTTL.Seconds()
	case authority.Kind == DecisionKindConnectionAuth && answer.Decision == "approve":
		if status, err = d.service.beginConnectionAuthorization(ctx, tx, authority, answer.ConnectionID, d.accountID); err != nil {
			return decisionOutcome{}, err
		}
		if status == "authorizing" {
			lifetime = connectionAuthorizationTTL.Seconds()
		}
	}
	var expiresAt pgtype.Timestamptz
	if err := tx.QueryRow(ctx, `UPDATE decisions SET status=$2, answer=$3, decided_at=clock_timestamp(), decided_by_actor_id=$5,
 finished_at=CASE WHEN $2 IN ('denied','answered','succeeded') THEN clock_timestamp() END,
 expires_at=CASE WHEN $4::float8>0 THEN clock_timestamp()+make_interval(secs => $4::float8) ELSE expires_at END
 WHERE id=$1 AND status IN ('pending','authorizing') RETURNING expires_at`, d.id, status, encoded, lifetime, authority.CallerActorID).Scan(&expiresAt); err != nil {
		return decisionOutcome{}, err
	}
	switch {
	case status == "authorizing":
		// The OAuth the Human started settles the card, or it expires.
		return decisionOutcome{}, jobs.InsertTx(ctx, tx, DecisionExpireArgs{DecisionID: d.id}, &river.InsertOpts{ScheduledAt: expiresAt.Time})
	case authority.Kind == DecisionKindRoomCreation:
		return d.roomCreationOutcome(ctx, tx, queries, answer)
	case authority.Kind == DecisionKindProfileSetupApps || authority.Kind == DecisionKindProfileSetupSources:
		// An AnotherMe setup card answers with visible Messages, never a handoff.
		messages, err := d.service.profileSetupOutcome(ctx, tx, queries, authority, answer, d.accountID, d.id)
		return decisionOutcome{messages: messages}, err
	case decisionRuns(authority.Kind) || authority.AlterEgoTaskID != "":
		// The run job runs the approved request, or hands the answer off to a
		// delegated Task's AlterEgo.
		return decisionOutcome{}, jobs.InsertTx(ctx, tx, jobs.DecisionRunArgs{DecisionID: d.id}, nil)
	}
	text, err := decisionNoticeText(d.id, decisionRecord{Kind: authority.Kind, Status: status, View: authority.View, Answer: encoded})
	if err != nil {
		return decisionOutcome{}, err
	}
	handoff, err := decisionHandoff(ctx, queries, authority.TenantID, authority.RoomID, authority.MessageID,
		authority.DeciderActorID, authority.RequestedByActorID, " "+text)
	if err != nil {
		return decisionOutcome{}, err
	}
	return decisionOutcome{messages: []messagecreation.Persisted{handoff}}, nil
}

// RunDecision runs an approved decision once its executor allows, records the
// result, and hands it off. It returns the notice for a delegated Task's
// AlterEgo, which the caller delivers.
func (s *Service) RunDecision(ctx context.Context, decisionID string) (DecisionNotice, error) {
	claim, run, err := s.claimDecision(ctx, decisionID)
	if errors.Is(err, ErrNotFound) {
		return DecisionNotice{}, nil
	}
	if err != nil {
		return DecisionNotice{}, err
	}
	if run {
		result, err := s.executors[claim.Kind].Run(ctx, claim)
		if err != nil {
			return DecisionNotice{}, err
		}
		if err := s.finishDecision(ctx, decisionID, result); err != nil {
			return DecisionNotice{}, err
		}
	}
	return s.HandOffDecision(ctx, decisionID)
}

// claimDecision marks an approved decision executing before its executor runs
// it. A decision found still executing stopped midway: an executor that
// declares Rerun runs it again; otherwise it ends unknown and never runs. A
// kind without an executor is only handed off.
func (s *Service) claimDecision(ctx context.Context, decisionID string) (ClaimedDecision, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ClaimedDecision{}, false, err
	}
	defer tx.Rollback(ctx)
	claim := ClaimedDecision{ID: decisionID}
	var status string
	err = tx.QueryRow(ctx, `SELECT kind, tenant_id, room_id, requested_by_actor_id, decider_actor_id, request, status
 FROM decisions WHERE id=$1 FOR UPDATE`, decisionID).Scan(
		&claim.Kind, &claim.TenantID, &claim.RoomID, &claim.RequestedByActorID, &claim.DeciderActorID, &claim.Request, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ClaimedDecision{}, false, ErrNotFound
	}
	if err != nil {
		return ClaimedDecision{}, false, err
	}
	if !decisionRuns(claim.Kind) || status != "approved" && status != "executing" {
		return claim, false, nil
	}
	executor, found := s.executors[claim.Kind]
	if !found {
		return ClaimedDecision{}, false, fmt.Errorf("no executor for decision kind %q", claim.Kind)
	}
	run := status == "approved" || executor.Rerun
	if run {
		_, err = tx.Exec(ctx, `UPDATE decisions SET status='executing' WHERE id=$1`, decisionID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE decisions SET status='unknown', finished_at=clock_timestamp(),
 result=jsonb_build_object('outcome', 'TeamHub stopped while running this request, so it may have taken effect.')
 WHERE id=$1`, decisionID)
	}
	if err != nil {
		return ClaimedDecision{}, false, err
	}
	return claim, run, tx.Commit(ctx)
}

// finishDecision records how a claimed run ended.
func (s *Service) finishDecision(ctx context.Context, decisionID string, result DecisionResult) error {
	if result.Status != "succeeded" && result.Status != "failed" && result.Status != "unknown" {
		return ErrInvalid
	}
	stored := map[string]any{"outcome": truncateText(result.Outcome, 2000)}
	if result.Data != nil {
		stored["data"] = result.Data
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE decisions SET status=$2, result=$3, finished_at=clock_timestamp()
 WHERE id=$1 AND status='executing'`, decisionID, result.Status, encoded)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	if result.Announce != nil && result.Status == "succeeded" {
		if err := result.Announce(ctx, store.New(tx)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ExpireDecision expires a decision nobody made in time, or a connection
// authorization whose OAuth did not complete in time, and hands that off in
// the same transaction: a Room Agent is told there, an AlterEgo through
// decision.run. It reports whether this call expired the decision; one that
// another path ended, a stopped Task's approval or a swept connection
// authorization included, is left alone, because that path handed it off or
// meant to tell nobody. When the decision is not due yet it returns how long
// to wait.
func (s *Service) ExpireDecision(ctx context.Context, decisionID string) (bool, time.Duration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback(ctx)
	var status string
	var remaining float64
	var alterEgo bool
	err = tx.QueryRow(ctx, `SELECT status, extract(epoch FROM expires_at-clock_timestamp())::float8, alter_ego_task_id IS NOT NULL
 FROM decisions WHERE id=$1 AND expires_at IS NOT NULL FOR UPDATE`, decisionID).Scan(&status, &remaining, &alterEgo)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	switch {
	case status != "pending" && status != "authorizing":
		return false, 0, nil
	case remaining > 0:
		return false, time.Duration(remaining*float64(time.Second)) + time.Second, nil
	}
	if _, err := tx.Exec(ctx, `UPDATE decisions SET status='expired', finished_at=clock_timestamp() WHERE id=$1`, decisionID); err != nil {
		return false, 0, err
	}
	if err := endSettledDecision(ctx, tx, decisionID, alterEgo); err != nil {
		return false, 0, err
	}
	return true, 0, tx.Commit(ctx)
}

// DecisionNotice tells a delegated Task's AlterEgo how its decision ended;
// the caller appends Text to the Task's private inbox.
type DecisionNotice struct {
	AgentManagementID string
	AlterEgoTaskID    string
	Text              string
}

// decisionRecord is the stored decision the projection and notices read.
type decisionRecord = store.ListDecisionsByMessagesRow

// HandOffDecision refreshes an ended decision's card and tells the waiting
// Agent how it ended. A Room Agent is told by an @mention in the card's Room;
// a delegated Task's AlterEgo is not reading that Room, so its notice is
// returned. It does nothing while the decision has not ended; an approved
// Runtime permission has, for its Agent may retry now.
func (s *Service) HandOffDecision(ctx context.Context, decisionID string) (DecisionNotice, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DecisionNotice{}, err
	}
	defer tx.Rollback(ctx)
	notice, err := handOffDecisionInTx(ctx, tx, decisionID)
	if err != nil {
		return DecisionNotice{}, err
	}
	return notice, tx.Commit(ctx)
}

// handOffDecisionInTx is HandOffDecision in the caller's transaction.
func handOffDecisionInTx(ctx context.Context, tx pgx.Tx, decisionID string) (DecisionNotice, error) {
	var decision decisionRecord
	var notice DecisionNotice
	err := tx.QueryRow(ctx, `SELECT decision.kind, decision.tenant_id, decision.room_id, decision.message_id,
 decision.requested_by_actor_id, decision.decider_actor_id, decision.status, decision.request, decision.view,
 decision.answer, decision.result, decision.alter_ego_task_id, registration.agent_management_id
 FROM decisions decision
 JOIN agent_registrations registration ON registration.actor_id=decision.requested_by_actor_id
  AND registration.tenant_id=decision.tenant_id
 WHERE decision.id=$1 FOR UPDATE OF decision`, decisionID).Scan(
		&decision.Kind, &decision.TenantID, &decision.RoomID, &decision.MessageID, &decision.RequestedByActorID,
		&decision.DeciderActorID, &decision.Status, &decision.Request, &decision.View, &decision.Answer, &decision.Result,
		&decision.AlterEgoTaskID, &notice.AgentManagementID)
	if errors.Is(err, pgx.ErrNoRows) {
		return DecisionNotice{}, nil
	}
	if err != nil {
		return DecisionNotice{}, err
	}
	notice.AlterEgoTaskID = decision.AlterEgoTaskID.String
	if !decisionEnded(decision.Status) && (decision.Kind != DecisionKindRuntimePermission || decision.Status != "approved") {
		return DecisionNotice{}, nil
	}
	notice.Text, err = decisionNoticeText(decisionID, decision)
	if err != nil {
		return DecisionNotice{}, err
	}
	queries := store.New(tx)
	if err := messagecreation.AdvanceCards(ctx, queries, decision.TenantID, decision.DeciderActorID, []string{decision.MessageID}); err != nil {
		return DecisionNotice{}, err
	}
	if notice.AlterEgoTaskID == "" && notice.Text != "" {
		handoff, err := decisionHandoff(ctx, queries, decision.TenantID, decision.RoomID, decision.MessageID,
			decision.DeciderActorID, decision.RequestedByActorID, " "+notice.Text)
		if err != nil {
			return DecisionNotice{}, err
		}
		if _, err := messagecreation.Publish(ctx, queries, handoff); err != nil {
			return DecisionNotice{}, err
		}
	}
	return notice, nil
}

func decisionEnded(status string) bool {
	return status != "pending" && status != "approved" && status != "executing" && status != "authorizing"
}

type decisionStoredResult struct {
	Outcome string          `json:"outcome"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// decisionNoticeText tells the requesting Agent how its decision ended; a
// delegated Task's AlterEgo may be told differently from a Room Agent. It is
// empty when nobody waits to hear: an AnotherMe setup card or a Room creation
// answers with Messages, a native question whose Run ended has nobody to
// answer, and a Document access card's Room Agents hear from the request.
func decisionNoticeText(decisionID string, decision decisionRecord) (string, error) {
	var answer decisionAnswer
	if len(decision.Answer) > 0 {
		if err := json.Unmarshal(decision.Answer, &answer); err != nil {
			return "", err
		}
	}
	var result decisionStoredResult
	if len(decision.Result) > 0 {
		if err := json.Unmarshal(decision.Result, &result); err != nil {
			return "", err
		}
	}
	switch decision.Kind {
	case DecisionKindConnectorWrite:
		var view ConnectorWriteView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return connectorWriteNoticeText(decisionID, view.Title, decision.Status, answer.Comment, result), nil
	case DecisionKindAgentChange:
		var view AgentChangeView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return agentChangeNoticeText(decisionID, view, decision.Status, answer.Comment, result), nil
	case DecisionKindRuntimePermission:
		var view RuntimePermissionCard
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return runtimePermissionNoticeText(decisionID, view, decision.Status, answer.Comment), nil
	case DecisionKindQuestion:
		if decision.Status != "answered" {
			return "", nil
		}
		var view questionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return questionNoticeText(decisionID, view, answer), nil
	case DecisionKindConnectionAuth:
		var view connectionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return connectionAuthNoticeText(decisionID, view, decision.Status, answer, decision.AlterEgoTaskID.Valid), nil
	case DecisionKindProviderKey:
		var view connectionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return providerKeyNoticeText(decisionID, view, decision.Status, decision.AlterEgoTaskID.Valid), nil
	case DecisionKindBrowserConnection:
		// A delegated Task's AlterEgo is not woken by a browser connection.
		if decision.AlterEgoTaskID.Valid {
			return "", nil
		}
		return browserConnectionNoticeText(decisionID, decision.Status), nil
	case DecisionKindComputerPermission:
		var view computerPermissionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return "", err
		}
		return computerPermissionNoticeText(decisionID, view, decision.Status), nil
	case DecisionKindProfileSetupApps, DecisionKindProfileSetupSources, DecisionKindRoomCreation:
		return "", nil
	default:
		return "", fmt.Errorf("unsupported decision kind %q", decision.Kind)
	}
}

// deniedNotice is the shared ending of a denial notice.
func deniedNotice(text, comment string) string {
	if comment != "" {
		text += "\nReason: " + comment
	}
	return text + "\nDo not try to achieve the same effect another way."
}

// decisionCard is the projection of a decision card.
type decisionCard struct {
	CardType      string          `json:"card_type"`
	Intent        string          `json:"intent"`
	Version       int64           `json:"version"`
	DecisionOwner cardActor       `json:"decision_owner"`
	Requester     cardActor       `json:"requester"`
	DecisionID    string          `json:"decision_id"`
	Kind          string          `json:"kind"`
	Title         string          `json:"title"`
	Status        string          `json:"status"`
	Outcome       string          `json:"outcome,omitempty"`
	ExpiresAt     *time.Time      `json:"expires_at,omitempty"`
	Answer        *decisionAnswer `json:"answer,omitempty"`
	DecidedBy     *cardActor      `json:"decided_by,omitempty"`
	DecidedAt     *time.Time      `json:"decided_at,omitempty"`
	// Exactly the view named by Kind is set; both AnotherMe setup kinds use
	// ProfileSetup.
	ConnectorWrite     json.RawMessage `json:"connector_write,omitempty"`
	AgentChange        json.RawMessage `json:"agent_change,omitempty"`
	Question           json.RawMessage `json:"question,omitempty"`
	RuntimePermission  json.RawMessage `json:"runtime_permission,omitempty"`
	ProfileSetup       json.RawMessage `json:"profile_setup,omitempty"`
	ConnectionAuth     json.RawMessage `json:"connection_auth,omitempty"`
	ProviderKey        json.RawMessage `json:"provider_key,omitempty"`
	BrowserConnection  json.RawMessage `json:"browser_connection,omitempty"`
	RoomCreation       json.RawMessage `json:"room_creation,omitempty"`
	ComputerPermission json.RawMessage `json:"computer_permission,omitempty"`
}

// encodeDecisionCard projects one decision card. decidedBy is the Human who
// decided it.
func encodeDecisionCard(
	record store.MessageCard, decider, requester store.Actor, decidedBy *store.Actor,
	decision decisionRecord,
) (json.RawMessage, error) {
	card := decisionCard{
		CardType: record.CardType, Intent: record.Intent, Version: record.Version,
		DecisionOwner: cardActorValue(decider), Requester: cardActorValue(requester),
		DecisionID: decision.ID, Kind: decision.Kind, Status: decision.Status,
	}
	if decision.ExpiresAt.Valid {
		expiresAt := decision.ExpiresAt.Time
		card.ExpiresAt = &expiresAt
	}
	var err error
	switch decision.Kind {
	case DecisionKindConnectorWrite:
		var view ConnectorWriteView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title, card.ConnectorWrite = view.Title, decision.View
	case DecisionKindAgentChange:
		var view AgentChangeView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title, card.AgentChange = agentChangeTitle(view), decision.View
	case DecisionKindRuntimePermission:
		var view RuntimePermissionCard
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title = view.Title
		if card.RuntimePermission, err = runtimePermissionCardView(decision.ID, decision.View); err != nil {
			return nil, err
		}
	case DecisionKindQuestion, DecisionKindProfileSetupApps, DecisionKindProfileSetupSources:
		var view openingView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title = view.Prompt
		if decision.Kind == DecisionKindQuestion {
			card.Question, err = json.Marshal(struct {
				Questions []DecisionQuestion `json:"questions"`
			}{view.Questions})
		} else {
			card.ProfileSetup, err = json.Marshal(struct {
				Apps     []string `json:"apps,omitempty"`
				MoreApps []string `json:"more_apps,omitempty"`
			}{view.Apps, view.MoreApps})
		}
		if err != nil {
			return nil, err
		}
	case DecisionKindConnectionAuth, DecisionKindBrowserConnection:
		var view connectionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title = view.Prompt
		if card.ConnectionAuth, card.BrowserConnection, err = connectionCardView(decision.Kind, view, decision.Answer); err != nil {
			return nil, err
		}
	case DecisionKindProviderKey:
		var view connectionView
		if err := json.Unmarshal(decision.View, &view); err != nil {
			return nil, err
		}
		card.Title = view.Prompt
		if card.ProviderKey, err = json.Marshal(struct {
			AppKey string `json:"app_key,omitempty"`
		}{view.AppKey}); err != nil {
			return nil, err
		}
	case DecisionKindRoomCreation:
		if card.Title, card.RoomCreation, err = roomCreationCardView(decision.View, decision.Result); err != nil {
			return nil, err
		}
	case DecisionKindComputerPermission:
		card.Title, card.ComputerPermission = computerPermissionTitle, decision.View
	default:
		return nil, fmt.Errorf("unsupported decision kind %q", decision.Kind)
	}
	if len(decision.Result) > 0 {
		var result decisionStoredResult
		if err := json.Unmarshal(decision.Result, &result); err != nil {
			return nil, err
		}
		card.Outcome = result.Outcome
	}
	if len(decision.Answer) > 0 {
		card.Answer = &decisionAnswer{}
		if err := json.Unmarshal(decision.Answer, card.Answer); err != nil {
			return nil, err
		}
		if decidedBy == nil {
			return nil, errors.New("answered decision has no decider")
		}
		actor := cardActorValue(*decidedBy)
		card.DecidedBy = &actor
		decidedAt := decision.DecidedAt.Time
		card.DecidedAt = &decidedAt
	}
	return json.Marshal(card)
}

func actorFromRoomAgent(authority store.GetRoomAgentMessageAuthorityRow) store.Actor {
	return store.Actor{
		ID: authority.AgentID, TenantID: authority.TenantID, Kind: authority.AgentKind,
		DisplayName: authority.AgentDisplayName, AccountID: authority.AgentAccountID,
		Handle: authority.AgentHandle, CreatedAt: authority.AgentCreatedAt,
	}
}

// decisionHandoff persists the hidden Message that hands a decision's result,
// written as text, to the Agent waiting on it.
func decisionHandoff(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID, cardMessageID, humanID, agentID, text string,
) (messagecreation.Persisted, error) {
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: humanID, TenantID: tenantID})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: agentID, TenantID: tenantID})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	return messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: roomID, Author: human, CardContextMessageID: cardMessageID,
	}, agent, text)
}
