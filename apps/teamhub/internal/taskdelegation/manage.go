package taskdelegation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

const (
	checkTaskTool = "check_task"
	sendTaskTool  = "send_task"
	stopTaskTool  = "stop_task"
)

var (
	// ErrNotFound hides a Task that does not exist, belongs to another Agent
	// or was delegated from another Room: only the origin Room's Meta sees it.
	ErrNotFound = errors.New("Task was not found")
	ErrConflict = errors.New("Task changed concurrently")
)

type TaskSummary struct {
	TaskID     string
	Name       string
	Status     string
	ReasonCode string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type TaskDetail struct {
	TaskID       string
	Name         string
	OriginRoomID string
	WorkRoomID   string
	CreatedAt    time.Time
	taskexecution.TaskView
}

// CheckResult holds one Task's detail, or the Room's Tasks when no Task was named.
type CheckResult struct {
	Task  *TaskDetail
	Tasks []TaskSummary
}

// Check shows one delegated Task, or lists the Tasks the caller's Room
// delegated, newest first.
func (s *Service) Check(
	ctx context.Context,
	token string,
	taskID string,
) (CheckResult, error) {
	taskID = strings.TrimSpace(taskID)
	if len(taskID) > 255 {
		return CheckResult{}, ErrInvalid
	}
	if s == nil || s.pool == nil || s.contexts == nil {
		return CheckResult{}, ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CheckResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.authorizeRoomMeta(ctx, tx, token, checkTaskTool)
	if err != nil {
		return CheckResult{}, err
	}
	queries := store.New(tx)
	var result CheckResult
	if taskID == "" {
		rows, err := queries.ListDelegatedTasksForCoordinator(ctx, store.ListDelegatedTasksForCoordinatorParams{
			AgentActorID: authorization.AgentActorID, OriginRoomID: authorization.RoomID, TenantID: authorization.TenantID,
		})
		if err != nil {
			return CheckResult{}, err
		}
		result.Tasks = make([]TaskSummary, 0, len(rows))
		for _, row := range rows {
			result.Tasks = append(result.Tasks, TaskSummary{
				TaskID: row.TaskID, Name: row.Title, Status: row.Status, ReasonCode: row.ReasonCode,
				CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time,
			})
		}
	} else {
		task, err := coordinatedTask(ctx, queries, authorization, taskID)
		if err != nil {
			return CheckResult{}, err
		}
		view, err := taskexecution.ReadTask(ctx, queries, taskID)
		if err != nil {
			return CheckResult{}, err
		}
		result.Task = &TaskDetail{
			TaskID: task.TaskID, Name: task.Title, OriginRoomID: task.OriginRoomID, WorkRoomID: task.WorkRoomID,
			CreatedAt: task.CreatedAt.Time, TaskView: view,
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return CheckResult{}, err
	}
	return result, nil
}

type SendInput struct {
	InvocationID string
	TaskID       string
	Message      string
	Steer        bool
}

type ChangeResult struct {
	TaskID   string
	Status   string
	Delivery string
	Replay   bool
	// ExecutionRevision is the committed Task revision to announce; 0 when
	// nothing changed.
	ExecutionRevision int64
}

type persistedChange struct {
	TaskID   string `json:"task_id"`
	Status   string `json:"status"`
	Delivery string `json:"delivery,omitempty"`
}

// Send gives a delegated Task's AlterEgo one Meta message: it wakes an idle,
// waiting, failed or canceled Task, queues behind a running turn, or with
// Steer asks to join the running turn.
func (s *Service) Send(
	ctx context.Context,
	token string,
	input SendInput,
) (ChangeResult, error) {
	input.TaskID = strings.TrimSpace(input.TaskID)
	input.Message = strings.TrimSpace(input.Message)
	if !invocationPattern.MatchString(input.InvocationID) || input.TaskID == "" || len(input.TaskID) > 255 ||
		input.Message == "" || utf8.RuneCountInString(input.Message) > taskexecution.MaxTaskInputRunes {
		return ChangeResult{}, ErrInvalid
	}
	requestHash, err := hashParts(input.TaskID, input.Message, boolText(input.Steer))
	if err != nil {
		return ChangeResult{}, err
	}
	return s.change(ctx, token, sendTaskTool, input.InvocationID, input.TaskID, requestHash,
		func(tx pgx.Tx, queries *store.Queries, authorization agentauth.Authorization) (ChangeResult, error) {
			status, err := queries.LockTaskExecutionSnapshot(ctx, input.TaskID)
			if err != nil {
				return ChangeResult{}, err
			}
			if status.TaskExecutionStatus.String != "running" {
				// Waking a Task counts toward the running cap; a queued message does not.
				if err := checkRunningCap(ctx, queries, authorization); err != nil {
					return ChangeResult{}, err
				}
			}
			result, err := taskexecution.AppendTaskInput(ctx, queries, taskexecution.TaskInput{
				TaskID: input.TaskID, Cause: taskexecution.TaskInputMetaMessage, Body: input.Message, Steer: input.Steer,
			})
			if err != nil {
				return ChangeResult{}, err
			}
			return ChangeResult{
				TaskID: input.TaskID, Status: result.Status, Delivery: result.Delivery,
				ExecutionRevision: result.ExecutionRevision,
			}, nil
		})
}

// Stop cancels a delegated Task's current turn and leaves it canceled with
// reason stopped; its session and playground stay for a later Send.
func (s *Service) Stop(
	ctx context.Context,
	token string,
	invocationID, taskID string,
) (ChangeResult, error) {
	taskID = strings.TrimSpace(taskID)
	if !invocationPattern.MatchString(invocationID) || taskID == "" || len(taskID) > 255 {
		return ChangeResult{}, ErrInvalid
	}
	requestHash, err := hashParts(taskID)
	if err != nil {
		return ChangeResult{}, err
	}
	return s.change(ctx, token, stopTaskTool, invocationID, taskID, requestHash,
		func(tx pgx.Tx, queries *store.Queries, authorization agentauth.Authorization) (ChangeResult, error) {
			revision, err := taskexecution.StopTask(ctx, queries, taskID, authorization.AgentActorID)
			if err != nil {
				return ChangeResult{}, err
			}
			// Stopping expires the cards the AlterEgo was waiting on.
			if err := jobs.InsertTx(ctx, tx, typedcard.StoppedTaskApprovalsArgs{TenantID: authorization.TenantID, TaskID: taskID}, nil); err != nil {
				return ChangeResult{}, err
			}
			return ChangeResult{TaskID: taskID, Status: "canceled", ExecutionRevision: revision}, nil
		})
}

// SendSystemInput wakes a delegated Task's AlterEgo with a system notice,
// such as the result of one of its approval cards, through the same input
// path as a Meta message. The Agent must be the Task's participant.
func (s *Service) SendSystemInput(ctx context.Context, agentManagementID, taskID, body string) (ChangeResult, error) {
	if s == nil || s.pool == nil {
		return ChangeResult{}, ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChangeResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	if _, err := queries.GetDelegatedTaskForAlterEgo(ctx, store.GetDelegatedTaskForAlterEgoParams{
		AgentManagementID: agentManagementID, TaskID: taskID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return ChangeResult{}, ErrNotFound
	} else if err != nil {
		return ChangeResult{}, err
	}
	if runes := []rune(strings.TrimSpace(body)); len(runes) > taskexecution.MaxTaskInputRunes {
		body = string(runes[:taskexecution.MaxTaskInputRunes-len("\n[truncated]")]) + "\n[truncated]"
	}
	result, err := taskexecution.AppendTaskInput(ctx, queries, taskexecution.TaskInput{
		TaskID: taskID, Cause: taskexecution.TaskInputSystem, Body: body,
	})
	if err != nil {
		return ChangeResult{}, mapTaskExecutionError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return ChangeResult{}, err
	}
	return ChangeResult{
		TaskID: taskID, Status: result.Status, Delivery: result.Delivery, ExecutionRevision: result.ExecutionRevision,
	}, nil
}

// change runs one idempotent Meta command on a Task its Room delegated.
func (s *Service) change(
	ctx context.Context,
	token string,
	tool, invocationID, taskID string,
	requestHash []byte,
	apply func(pgx.Tx, *store.Queries, agentauth.Authorization) (ChangeResult, error),
) (ChangeResult, error) {
	if s == nil || s.pool == nil || s.contexts == nil {
		return ChangeResult{}, ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ChangeResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.authorizeRoomMeta(ctx, tx, token, tool)
	if err != nil {
		return ChangeResult{}, err
	}
	receipt, replay, err := agentauth.LookupReceipt(ctx, tx, authorization.Principal, tool, invocationID, requestHash)
	if errors.Is(err, agentauth.ErrReceiptConflict) {
		return ChangeResult{}, ErrIdempotencyConflict
	}
	if err != nil {
		return ChangeResult{}, err
	}
	if replay {
		var stored persistedChange
		if err := json.Unmarshal(receipt.Body, &stored); err != nil || stored.TaskID == "" {
			return ChangeResult{}, ErrUnavailable
		}
		if err := tx.Commit(ctx); err != nil {
			return ChangeResult{}, err
		}
		return ChangeResult{TaskID: stored.TaskID, Status: stored.Status, Delivery: stored.Delivery, Replay: true}, nil
	}
	queries := store.New(tx)
	if _, err := coordinatedTask(ctx, queries, authorization, taskID); err != nil {
		return ChangeResult{}, err
	}
	result, err := apply(tx, queries, authorization)
	if err != nil {
		return ChangeResult{}, mapTaskExecutionError(err)
	}
	body, err := json.Marshal(persistedChange{TaskID: result.TaskID, Status: result.Status, Delivery: result.Delivery})
	if err != nil {
		return ChangeResult{}, err
	}
	if err := agentauth.SaveReceipt(ctx, tx, authorization.Principal, tool, invocationID, requestHash,
		agentauth.Receipt{ResourceID: taskID, Body: body}); err != nil {
		return ChangeResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ChangeResult{}, err
	}
	return result, nil
}

// authorizeRoomMeta admits only a Room Context: a Task's AlterEgo cannot
// manage Tasks, and a Meta manages only what its own Room delegated.
func (s *Service) authorizeRoomMeta(
	ctx context.Context,
	tx pgx.Tx,
	token, tool string,
) (agentauth.Authorization, error) {
	authorization, err := s.contexts.AuthorizeInTx(ctx, tx, token, tool)
	if err != nil {
		return agentauth.Authorization{}, err
	}
	if authorization.Target.Kind != "room" || authorization.RoomID == "" || authorization.ParticipantTaskID != "" {
		return agentauth.Authorization{}, ErrForbidden
	}
	return authorization, nil
}

func coordinatedTask(
	ctx context.Context,
	queries *store.Queries,
	authorization agentauth.Authorization,
	taskID string,
) (store.GetDelegatedTaskForCoordinatorRow, error) {
	task, err := queries.GetDelegatedTaskForCoordinator(ctx, store.GetDelegatedTaskForCoordinatorParams{
		AgentActorID: authorization.AgentActorID, OriginRoomID: authorization.RoomID,
		TaskID: taskID, TenantID: authorization.TenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.GetDelegatedTaskForCoordinatorRow{}, ErrNotFound
	}
	return task, err
}

// checkRunningCap counts and changes running Tasks under one per-Agent lock
// so concurrent creates and wakes respect MaxRunningTasks.
func checkRunningCap(ctx context.Context, queries *store.Queries, authorization agentauth.Authorization) error {
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "task-delegation|"+authorization.AgentActorID); err != nil {
		return err
	}
	running, err := queries.CountRunningDelegatedTasksForAgent(ctx, store.CountRunningDelegatedTasksForAgentParams{
		TenantID: authorization.TenantID, AgentActorID: authorization.AgentActorID,
	})
	if err != nil {
		return err
	}
	if running >= MaxRunningTasks {
		return ErrLimitReached
	}
	return nil
}

func mapTaskExecutionError(err error) error {
	switch {
	case errors.Is(err, taskexecution.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, taskexecution.ErrInvalid):
		return ErrInvalid
	case errors.Is(err, taskexecution.ErrConflict):
		return ErrConflict
	}
	return err
}

func hashParts(parts ...string) ([]byte, error) {
	encoded, err := json.Marshal(parts)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	return digest[:], nil
}

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
