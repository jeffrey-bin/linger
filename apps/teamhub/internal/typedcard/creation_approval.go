package typedcard

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// CreationApprovalSubmission is an Agent's Room creation request: what it
// sent, what TeamHub made of it, and the Room it froze for the decision. It
// is the decision's stored request.
type CreationApprovalSubmission struct {
	SubmissionID        string          `json:"submission_id"`
	CallerInput         json.RawMessage `json:"caller_input"`
	EffectivePayload    json.RawMessage `json:"effective_payload"`
	FulfillmentSnapshot json.RawMessage `json:"fulfillment_snapshot"`
}

type CreationApprovalInTxInput struct {
	RoomID               string
	AgentManagementID    string
	ExpectedAgentActorID string
	ExpectedTenantID     string
	IdempotencyOperation string
	CallerInputHash      []byte
	Submission           CreationApprovalSubmission
	BeforeCreate         CreationApprovalBeforeCreate
}

type CreationApprovalSource struct {
	TenantID          string
	AgentActorID      string
	AgentManagementID string
	CreatedByActorID  string
	DecisionOwner     store.Actor
}

type CreationApprovalBeforeCreate func(
	context.Context,
	*store.Queries,
	CreationApprovalSource,
	*CreationApprovalSubmission,
) error

// CreateCreationApprovalRequestInTx posts a Room creation decision for the
// requesting Agent's creator in the caller's transaction. A retried
// submission replays its card.
func (s *Service) CreateCreationApprovalRequestInTx(
	ctx context.Context,
	tx pgx.Tx,
	input CreationApprovalInTxInput,
) (CreateResult, error) {
	command, err := normalizeCreationApprovalSubmission(input.Submission)
	if err != nil {
		return CreateResult{}, err
	}
	if s == nil || tx == nil || input.RoomID == "" || input.AgentManagementID == "" ||
		strings.TrimSpace(input.IdempotencyOperation) == "" || len(input.IdempotencyOperation) > 300 ||
		len(input.CallerInputHash) != sha256.Size {
		return CreateResult{}, ErrInvalid
	}
	operation := strings.TrimSpace(input.IdempotencyOperation)
	queries := store.New(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+input.RoomID); err != nil {
		return CreateResult{}, err
	}
	source, err := queries.ResolveCreationApprovalAgentSource(ctx, store.ResolveCreationApprovalAgentSourceParams{
		RoomID: input.RoomID, AgentManagementID: input.AgentManagementID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrNotFound
	}
	if err != nil {
		return CreateResult{}, err
	}
	if input.ExpectedAgentActorID != "" && source.AgentActorID != input.ExpectedAgentActorID ||
		input.ExpectedTenantID != "" && source.TenantID != input.ExpectedTenantID {
		return CreateResult{}, ErrForbidden
	}
	if err := idempotency.Lock(ctx, tx, idempotency.AgentKey(source.AgentActorID, operation, command.SubmissionID)); err != nil {
		return CreateResult{}, err
	}
	if replay, found, err := lookupCreationApprovalReplay(
		ctx, queries, source.AgentActorID, operation, command.SubmissionID, input.CallerInputHash,
	); err != nil || found {
		return replay, err
	}
	author := store.Actor{
		ID: source.AgentActorID, TenantID: source.TenantID, Kind: source.AgentKind,
		DisplayName: source.AgentDisplayName, AccountID: source.AgentAccountID,
		Handle: source.AgentHandle, CreatedAt: source.AgentCreatedAt,
	}
	decisionOwner := store.Actor{
		ID: source.CreatedByActorID, TenantID: source.TenantID, Kind: "human",
	}
	decisionOwner, err = queries.GetActor(ctx, store.GetActorParams{ID: decisionOwner.ID, TenantID: source.TenantID})
	if err != nil {
		return CreateResult{}, err
	}
	if input.BeforeCreate != nil {
		if err := input.BeforeCreate(ctx, queries, CreationApprovalSource{
			TenantID: source.TenantID, AgentActorID: source.AgentActorID,
			AgentManagementID: input.AgentManagementID, CreatedByActorID: source.CreatedByActorID,
			DecisionOwner: decisionOwner,
		}, &command); err != nil {
			return CreateResult{}, err
		}
		if command, err = normalizeCreationApprovalSubmission(command); err != nil {
			return CreateResult{}, err
		}
	}
	var snapshot RoomCreationSnapshot
	if err := json.Unmarshal(command.FulfillmentSnapshot, &snapshot); err != nil {
		return CreateResult{}, ErrInvalid
	}
	view, err := json.Marshal(roomCreationProposalValue(snapshot))
	if err != nil {
		return CreateResult{}, err
	}
	request, err := json.Marshal(command)
	if err != nil {
		return CreateResult{}, err
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: roomCreationTitle(snapshot.Name)}})
	if err != nil {
		return CreateResult{}, err
	}
	message, err := messagecreation.Persist(ctx, queries, messagecreation.Draft{
		TenantID: source.TenantID, RoomID: input.RoomID, Author: author, Content: content,
		Card: &messagecreation.Card{DecisionOwnerActorID: decisionOwner.ID, CardType: "personal_notice", Intent: "decision_requested"},
	})
	if err != nil {
		return CreateResult{}, err
	}
	decisionID := idgen.New("decision")
	// A Room creation waits until it is decided.
	if _, err := queries.InsertDecision(ctx, store.InsertDecisionParams{
		ID: decisionID, TenantID: source.TenantID, RoomID: input.RoomID, MessageID: message.Message.ID,
		Kind: DecisionKindRoomCreation, RequestedByActorID: author.ID, DeciderActorID: decisionOwner.ID,
		Request: request, View: view,
	}); err != nil {
		return CreateResult{}, err
	}
	published, err := publishCardMessage(ctx, queries, message)
	if err != nil {
		return CreateResult{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AgentKey(author.ID, operation, command.SubmissionID),
		input.CallerInputHash, idempotency.Record{
			ResourceID: published.Message.ID, Status: http.StatusCreated, Body: published.Payload,
		}); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{
		Status: http.StatusCreated, Body: published.Payload, MessageID: published.Message.ID,
		DecisionID: decisionID,
	}, nil
}

func roomCreationTitle(name string) string {
	return fmt.Sprintf("Request to create a collaboration room: %s", name)
}

func normalizeCreationApprovalSubmission(input CreationApprovalSubmission) (CreationApprovalSubmission, error) {
	input.SubmissionID = strings.TrimSpace(input.SubmissionID)
	if input.SubmissionID == "" || len(input.SubmissionID) > 200 ||
		!jsonObject(input.CallerInput) || !jsonObject(input.EffectivePayload) ||
		!jsonObject(input.FulfillmentSnapshot) {
		return CreationApprovalSubmission{}, ErrInvalid
	}
	return input, nil
}

func jsonObject(value json.RawMessage) bool {
	if len(value) == 0 || !json.Valid(value) {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(value, &object) == nil && object != nil
}

func lookupCreationApprovalReplay(
	ctx context.Context,
	queries *store.Queries,
	agentActorID, operation, submissionID string,
	callerInputHash []byte,
) (CreateResult, bool, error) {
	record, err := queries.GetRoomCreationSubmissionReplay(ctx, store.GetRoomCreationSubmissionReplayParams{
		AgentActorID: agentActorID, SubmissionID: submissionID, Operation: operation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, false, nil
	}
	if err != nil {
		return CreateResult{}, false, err
	}
	if !bytes.Equal(record.RequestHash, callerInputHash) {
		return CreateResult{}, false, ErrIdempotencyConflict
	}
	return CreateResult{
		Status: int(record.ResponseStatus.Int32), Body: record.ResponseBody, Replay: true,
		MessageID: record.MessageID, DecisionID: record.ID,
	}, true, nil
}

// roomCreationCardView is a Room creation card's title and view: the frozen
// Room, and once approved, the Room it created.
func roomCreationCardView(view, rawResult []byte) (string, json.RawMessage, error) {
	var proposal roomCreationProposal
	if err := json.Unmarshal(view, &proposal); err != nil {
		return "", nil, err
	}
	var result struct {
		Data struct {
			CreatedRoomID string `json:"created_room_id"`
		} `json:"data"`
	}
	if len(rawResult) > 0 {
		if err := json.Unmarshal(rawResult, &result); err != nil {
			return "", nil, err
		}
	}
	encoded, err := json.Marshal(struct {
		roomCreationProposal
		CreatedRoomID string `json:"created_room_id,omitempty"`
	}{proposal, result.Data.CreatedRoomID})
	return roomCreationTitle(proposal.Name), encoded, err
}

type roomCreationProposal struct {
	OriginRoomID           string                    `json:"origin_room_id"`
	Name                   string                    `json:"name"`
	Description            *string                   `json:"description,omitempty"`
	MemberIDs              []string                  `json:"member_ids"`
	InitialMessageSegments []messagecreation.Segment `json:"initial_message_segments"`
}

func roomCreationProposalValue(snapshot RoomCreationSnapshot) roomCreationProposal {
	return roomCreationProposal{
		OriginRoomID: snapshot.OriginRoomID, Name: snapshot.Name, Description: snapshot.Description,
		MemberIDs: snapshot.MemberIDs, InitialMessageSegments: snapshot.InitialMessageSegments,
	}
}
