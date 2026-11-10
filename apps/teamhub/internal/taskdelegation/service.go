// Package taskdelegation lets a Room's Meta delegate Tasks to its own
// AlterEgo without Human approval.
package taskdelegation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

const (
	createTaskTool = "create_task"
	// MaxRunningTasks bounds concurrent AlterEgos competing for one Computer.
	MaxRunningTasks = 10
)

var (
	ErrInvalid             = errors.New("Task delegation input is invalid")
	ErrForbidden           = errors.New("Task delegation is forbidden for this Context")
	ErrLimitReached        = errors.New("the Agent already has the maximum number of running Tasks")
	ErrIdempotencyConflict = errors.New("Task delegation invocation was reused with different input")
	ErrUnavailable         = errors.New("Task delegation service is unavailable")

	invocationPattern = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
)

type CreateInput struct {
	InvocationID string
	Name         string
	Requirement  string
}

type CreateResult struct {
	TaskID string
	Replay bool
}

type persistedCreate struct {
	TaskID string `json:"task_id"`
}

type Service struct {
	pool     *pgxpool.Pool
	contexts *agentauth.Service
}

func New(pool *pgxpool.Pool, contexts *agentauth.Service) *Service {
	return &Service{pool: pool, contexts: contexts}
}

// Create starts a Task for the caller's own AlterEgo. The origin Room is the
// caller's Room Context; a Task Context cannot delegate.
func (s *Service) Create(
	ctx context.Context,
	token string,
	input CreateInput,
) (CreateResult, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Requirement = strings.TrimSpace(input.Requirement)
	if !invocationPattern.MatchString(input.InvocationID) || input.Name == "" || input.Requirement == "" ||
		utf8.RuneCountInString(input.Name) > 120 || utf8.RuneCountInString(input.Requirement) > 20000 {
		return CreateResult{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.contexts == nil {
		return CreateResult{}, ErrUnavailable
	}
	requestHash, err := hashRequest(input)
	if err != nil {
		return CreateResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, createTaskTool)
	if err != nil {
		return CreateResult{}, err
	}
	if authorization.Target.Kind != "room" || authorization.RoomID == "" || authorization.ParticipantTaskID != "" {
		return CreateResult{}, ErrForbidden
	}
	receipt, replay, err := agentauth.LookupReceipt(ctx, tx, authorization.Principal, createTaskTool, input.InvocationID, requestHash)
	if errors.Is(err, agentauth.ErrReceiptConflict) {
		return CreateResult{}, ErrIdempotencyConflict
	}
	if err != nil {
		return CreateResult{}, err
	}
	if replay {
		var stored persistedCreate
		if err := json.Unmarshal(receipt.Body, &stored); err != nil || stored.TaskID == "" {
			return CreateResult{}, ErrUnavailable
		}
		if err := tx.Commit(ctx); err != nil {
			return CreateResult{}, err
		}
		return CreateResult{TaskID: stored.TaskID, Replay: true}, nil
	}
	queries := store.New(tx)
	if _, err := queries.LockActiveRoomForMutation(ctx, authorization.RoomID); errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrForbidden
	} else if err != nil {
		return CreateResult{}, err
	}
	// Count and insert under one per-Agent lock so concurrent creates respect the cap.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "task-delegation|"+authorization.AgentActorID); err != nil {
		return CreateResult{}, err
	}
	running, err := queries.CountRunningDelegatedTasksForAgent(ctx, store.CountRunningDelegatedTasksForAgentParams{
		TenantID: authorization.TenantID, AgentActorID: authorization.AgentActorID,
	})
	if err != nil {
		return CreateResult{}, err
	}
	if running >= MaxRunningTasks {
		return CreateResult{}, ErrLimitReached
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: authorization.AgentActorID, TenantID: authorization.TenantID})
	if err != nil {
		return CreateResult{}, err
	}
	sponsor, err := queries.GetActor(ctx, store.GetActorParams{ID: authorization.SponsorActorID, TenantID: authorization.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (sponsor.Kind != "human" || !sponsor.AccountID.Valid) {
		return CreateResult{}, ErrForbidden
	}
	if err != nil {
		return CreateResult{}, err
	}
	created, err := typedcard.CreateDelegatedTaskInTx(ctx, tx, queries, typedcard.DelegatedTaskInput{
		TenantID: authorization.TenantID, OriginRoomID: authorization.RoomID,
		Agent: agent, AgentManagementID: authorization.AgentID, Sponsor: sponsor,
		Name: input.Name, Requirement: input.Requirement,
		SourceKey: "task_delegation:" + operationKey(authorization, input.InvocationID),
	})
	if errors.Is(err, typedcard.ErrInvalid) {
		return CreateResult{}, ErrInvalid
	}
	if err != nil {
		return CreateResult{}, err
	}
	body, err := json.Marshal(persistedCreate{TaskID: created.TaskID})
	if err != nil {
		return CreateResult{}, err
	}
	if err := agentauth.SaveReceipt(ctx, tx, authorization.Principal, createTaskTool, input.InvocationID, requestHash,
		agentauth.Receipt{ResourceID: created.TaskID, Body: body}); err != nil {
		return CreateResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{TaskID: created.TaskID}, nil
}

func hashRequest(input CreateInput) ([]byte, error) {
	encoded, err := json.Marshal([]string{input.Name, input.Requirement})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	return digest[:], nil
}

func operationKey(authorization agentauth.Authorization, invocationID string) string {
	key, _ := json.Marshal([]string{authorization.TenantID, authorization.AgentActorID, invocationID})
	digest := sha256.Sum256(key)
	return hex.EncodeToString(digest[:])
}
