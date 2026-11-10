package agentdirectmessage

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/tenantmembership"
)

const (
	sendDirectMessageToolName = "send_direct_message"
	idempotencyOperation      = "send_direct_message"
	maxMessages               = 100
)

var (
	ErrIdentityInvalid     = errors.New("Agent identity is invalid")
	ErrInvalid             = errors.New("Agent Direct Message input is invalid")
	ErrForbidden           = errors.New("Agent Direct Message is forbidden")
	ErrIdempotencyConflict = errors.New("Agent Direct Message invocation was reused with different input")
	ErrSponsorUnavailable  = errors.New("Agent Direct Message Human sponsor is unavailable")
	ErrUnavailable         = errors.New("Agent Direct Message service is unavailable")
	invocationPattern      = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
)

type Input struct {
	InvocationID string
	Messages     []string
}

type Result struct {
	Accepted    bool
	InboxID     string
	MessageIDs  []string
	RoomCreated bool
	Replay      bool
}

type persistedResult struct {
	Accepted    bool     `json:"accepted"`
	InboxID     string   `json:"inbox_id"`
	MessageIDs  []string `json:"message_ids"`
	RoomCreated bool     `json:"room_created"`
}

type Service struct {
	pool          *pgxpool.Pool
	authorizer    *agentauth.Service
	createMessage func(context.Context, *store.Queries, messagecreation.Draft) (messagecreation.Result, error)
}

func New(pool *pgxpool.Pool, authorizer *agentauth.Service) *Service {
	return &Service{pool: pool, authorizer: authorizer, createMessage: messagecreation.Create}
}

func (s *Service) Send(
	ctx context.Context,
	contextToken string,
	input Input,
) (Result, error) {
	contents, normalizedMessages, err := normalizeInput(input)
	if err != nil {
		return Result{}, err
	}
	if s == nil || s.pool == nil || s.authorizer == nil || s.createMessage == nil {
		return Result{}, ErrUnavailable
	}
	// Creating the first Direct Room admits the Agent into a new Room, which
	// takes the Agent lock before any row lock. The Agent is known only after
	// authorization, so a send that must create the Room runs again holding
	// that lock from the start.
	result, err := s.send(ctx, contextToken, input, contents, normalizedMessages, "")
	var required agentLockRequired
	if errors.As(err, &required) {
		result, err = s.send(ctx, contextToken, input, contents, normalizedMessages, required.agentID)
	}
	return result, err
}

type agentLockRequired struct{ agentID string }

func (agentLockRequired) Error() string {
	return "creating the Direct Room requires the Agent lock first"
}

func (s *Service) send(
	ctx context.Context,
	contextToken string,
	input Input,
	contents []messagecreation.Content,
	normalizedMessages []string,
	lockedAgentID string,
) (Result, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	if lockedAgentID != "" {
		if err := tenantmembership.LockAgent(ctx, queries, lockedAgentID); err != nil {
			return Result{}, err
		}
	}

	authorization, err := s.authorizer.AuthorizeInTx(
		ctx,
		tx,
		contextToken,
		sendDirectMessageToolName,
	)
	if err != nil {
		return Result{}, err
	}

	authority, err := resolveAuthorityForShare(ctx, tx, authorization)
	if err != nil {
		switch {
		case errors.Is(err, ErrSponsorUnavailable):
			return Result{}, ErrSponsorUnavailable
		case errors.Is(err, ErrIdentityInvalid):
			return Result{}, ErrIdentityInvalid
		default:
			return Result{}, err
		}
	}
	tenantID := authorization.TenantID
	if authority.Agent.ID != authorization.AgentActorID ||
		authority.Agent.TenantID != tenantID ||
		authority.Sponsor.TenantID != tenantID ||
		lockedAgentID != "" && lockedAgentID != authority.Agent.ID {
		return Result{}, ErrUnavailable
	}

	requestHash := hashNormalizedMessages(normalizedMessages)
	idempotencyKey := agentauth.IdempotencyKey(idempotencyOperation, input.InvocationID)
	if err := idempotency.Lock(ctx, tx, idempotency.AgentKey(authority.Agent.ID, idempotencyOperation, idempotencyKey)); err != nil {
		return Result{}, err
	}
	if replay, found, err := lookupReplay(
		ctx,
		tx,
		authority.Agent.ID,
		authority.Sponsor.ID,
		tenantID,
		idempotencyKey,
		requestHash[:],
	); err != nil {
		return Result{}, err
	} else if found {
		if err := tx.Commit(ctx); err != nil {
			return Result{}, err
		}
		return replay, nil
	}

	room, err := queries.GetDirectRoomByPair(ctx, store.GetDirectRoomByPairParams{
		TenantID: tenantID, HumanActorID: authority.Sponsor.ID, AgentActorID: authority.Agent.ID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Result{}, err
	}
	roomID := room.ID
	roomCreated := false
	if err != nil || room.DeletionStartedAt.Valid {
		if lockedAgentID == "" {
			return Result{}, agentLockRequired{agentID: authority.Agent.ID}
		}
		direct, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
			TenantID: tenantID, Human: authority.Sponsor, Agent: authority.Agent,
			ByAgent: true, Name: authority.Agent.DisplayName,
		})
		if err != nil {
			return Result{}, translateCreationError(err)
		}
		roomID, roomCreated = direct.Room.ID, direct.Created
	}

	messageIDs := make([]string, 0, len(contents))
	for _, content := range contents {
		created, err := s.createMessage(ctx, queries, messagecreation.Draft{
			TenantID: tenantID, RoomID: roomID, Author: authority.Agent, Content: content,
		})
		if err != nil {
			return Result{}, err
		}
		messageIDs = append(messageIDs, created.Message.ID)
	}
	stored := persistedResult{
		Accepted: true, InboxID: "room:" + roomID, MessageIDs: messageIDs,
		RoomCreated: roomCreated}
	body, err := json.Marshal(stored)
	if err != nil {
		return Result{}, err
	}
	if err := idempotency.Save(ctx, tx, idempotency.AgentKey(authority.Agent.ID, idempotencyOperation, idempotencyKey), requestHash[:], idempotency.Record{
		ResourceID: roomID, Status: http.StatusOK, Body: body,
	}); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return resultFromPersisted(stored, false), nil
}

// agentAuthority is the Agent writing and the Human sponsor it writes to.
type agentAuthority struct {
	Agent   store.Actor
	Sponsor store.Actor
}

func resolveAuthorityForShare(ctx context.Context, tx pgx.Tx, identity agentauth.Authorization) (agentAuthority, error) {
	row := tx.QueryRow(ctx, `
		SELECT agent.id,agent.tenant_id,agent.kind,agent.display_name,
		       agent.account_id,agent.handle,agent.created_at,
		       sponsor.id,sponsor.tenant_id,sponsor.kind,sponsor.display_name,
		       sponsor.account_id,sponsor.handle,sponsor.created_at
		FROM agent_registrations registration
		JOIN actors agent
		  ON agent.id=registration.actor_id AND agent.tenant_id=registration.tenant_id
		JOIN actors sponsor
		  ON sponsor.id=registration.created_by_actor_id
		 AND sponsor.tenant_id=registration.tenant_id
		WHERE registration.agent_management_id=$1
		  AND registration.actor_id=$2
		  AND registration.tenant_id=$3
		  AND registration.status='active'
		FOR SHARE OF registration,agent,sponsor
	`, identity.AgentID, identity.AgentActorID, identity.TenantID)
	var authority agentAuthority
	err := row.Scan(
		&authority.Agent.ID,
		&authority.Agent.TenantID,
		&authority.Agent.Kind,
		&authority.Agent.DisplayName,
		&authority.Agent.AccountID,
		&authority.Agent.Handle,
		&authority.Agent.CreatedAt,
		&authority.Sponsor.ID,
		&authority.Sponsor.TenantID,
		&authority.Sponsor.Kind,
		&authority.Sponsor.DisplayName,
		&authority.Sponsor.AccountID,
		&authority.Sponsor.Handle,
		&authority.Sponsor.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentAuthority{}, ErrIdentityInvalid
	}
	if err != nil {
		return agentAuthority{}, err
	}
	if authority.Agent.Kind != "agent" {
		return agentAuthority{}, ErrIdentityInvalid
	}
	if authority.Sponsor.Kind != "human" || !authority.Sponsor.AccountID.Valid || authority.Sponsor.AccountID.String == "" {
		return agentAuthority{}, ErrSponsorUnavailable
	}
	return authority, nil
}

func normalizeInput(input Input) ([]messagecreation.Content, []string, error) {
	if !invocationPattern.MatchString(input.InvocationID) || len(input.Messages) < 1 || len(input.Messages) > maxMessages {
		return nil, nil, ErrInvalid
	}
	contents := make([]messagecreation.Content, 0, len(input.Messages))
	normalizedMessages := make([]string, 0, len(input.Messages))
	for _, message := range input.Messages {
		content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: message}})
		if err != nil {
			return nil, nil, ErrInvalid
		}
		contents = append(contents, content)
		normalizedMessages = append(normalizedMessages, content.RawMessage)
	}
	return contents, normalizedMessages, nil
}

func hashNormalizedMessages(messages []string) [sha256.Size]byte {
	encoded, err := json.Marshal(messages)
	if err != nil {
		panic(err)
	}
	return sha256.Sum256(encoded)
}

func lookupReplay(
	ctx context.Context,
	tx pgx.Tx,
	agentActorID string,
	sponsorActorID string,
	tenantID string,
	idempotencyKey string,
	requestHash []byte,
) (Result, bool, error) {
	record, found, err := idempotency.Lookup(ctx, tx, idempotency.AgentKey(agentActorID, idempotencyOperation, idempotencyKey), requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return Result{}, false, ErrIdempotencyConflict
	}
	if err != nil || !found {
		return Result{}, false, err
	}
	queries := store.New(tx)
	currentRoom, err := queries.GetDirectRoomByPair(ctx, store.GetDirectRoomByPairParams{
		TenantID: tenantID, HumanActorID: sponsorActorID, AgentActorID: agentActorID,
	})
	if err != nil || currentRoom.ID != record.ResourceID {
		return Result{}, false, ErrUnavailable
	}
	var stored persistedResult
	if err := json.Unmarshal(record.Body, &stored); err != nil ||
		!stored.Accepted || stored.InboxID != "room:"+record.ResourceID ||
		len(stored.MessageIDs) < 1 || len(stored.MessageIDs) > maxMessages {
		return Result{}, false, ErrUnavailable
	}
	for _, messageID := range stored.MessageIDs {
		if messageID == "" {
			return Result{}, false, ErrUnavailable
		}
	}
	return resultFromPersisted(stored, true), true, nil
}

func resultFromPersisted(stored persistedResult, replay bool) Result {
	return Result{
		Accepted:    stored.Accepted,
		InboxID:     stored.InboxID,
		MessageIDs:  append([]string(nil), stored.MessageIDs...),
		RoomCreated: stored.RoomCreated,
		Replay:      replay,
	}
}

func translateCreationError(err error) error {
	switch {
	case errors.Is(err, roomcreation.ErrNotFound), errors.Is(err, roomcreation.ErrAgentUnavailable):
		return ErrIdentityInvalid
	case errors.Is(err, roomcreation.ErrInvalid), errors.Is(err, roomcreation.ErrAgentSponsorRequired),
		errors.Is(err, roomcreation.ErrDirectRoomDeleting):
		return ErrUnavailable
	default:
		return err
	}
}
