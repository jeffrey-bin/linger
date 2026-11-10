package app

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listTaskRuntimePresentationRuns(c *gin.Context) {
	params := contractParams[httpapi.ListTaskRuntimePresentationRunsParams](c)
	taskID := c.Param("taskId")
	limit := runtimePresentationDefaultLimit
	if params.Limit != nil {
		limit = *params.Limit
	}
	before, valid := taskPresentationCursor(taskID, params.Cursor)
	if !valid || limit < 1 || limit > runtimePresentationMaxLimit {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Task activity pagination is invalid")
		return
	}
	ctx := c.Request.Context()
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		a.internalError(c, "begin Task activity read", err)
		return
	}
	defer tx.Rollback(ctx)
	queries := a.queries.WithTx(tx)
	accountID := currentPrincipal(c).Session.AccountID
	item, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{ID: taskID, AccountID: accountID})
	if a.notFoundOrError(c, "authorize Task activities", err) {
		return
	}
	if item.Kind != "task" {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "resource was not found")
		return
	}
	_, err = queries.GetWorkItemRoomLink(ctx, store.GetWorkItemRoomLinkParams{WorkItemID: taskID, LinkType: "work"})
	if errors.Is(err, pgx.ErrNoRows) {
		c.JSON(http.StatusOK, httpapi.TaskRuntimePresentationRunPage{ActiveItems: []httpapi.RoomRunStatus{}, HistoryItems: []httpapi.RoomRunStatus{}})
		return
	}
	if err != nil {
		a.internalError(c, "get Task work Room", err)
		return
	}
	roomID, err := queries.GetTaskRuntimePresentationRoomForAccount(ctx, store.GetTaskRuntimePresentationRoomForAccountParams{TaskID: taskID, AccountID: accountID})
	if a.notFoundOrError(c, "authorize Task work Room", err) {
		return
	}
	query := store.ListTaskRuntimePresentationRunsParams{TaskID: taskID, TenantID: item.TenantID, RoomID: roomID, ActiveOnly: true}
	active, err := queries.ListTaskRuntimePresentationRuns(ctx, query)
	if err != nil {
		a.internalError(c, "read active Task activities", err)
		return
	}
	query.ActiveOnly = false
	query.BeforeCreatedAt, query.BeforeRunID = before.createdAt, before.runID
	query.ResultLimit = pgtype.Int4{Int32: int32(limit + 1), Valid: true}
	history, err := queries.ListTaskRuntimePresentationRuns(ctx, query)
	if err != nil {
		a.internalError(c, "read Task activity history", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		a.internalError(c, "finish Task activity read", err)
		return
	}
	result := httpapi.TaskRuntimePresentationRunPage{WorkRoomId: &roomID, ActiveItems: taskPresentationRuns(active)}
	if len(history) > limit {
		history = history[:limit]
		last := history[len(history)-1]
		cursor := base64.RawURLEncoding.EncodeToString([]byte(taskID + "\n" + strconv.FormatInt(last.CreatedAt.Time.UnixMicro(), 10) + "\n" + last.RunID))
		result.NextCursor = &cursor
	}
	result.HistoryItems = taskPresentationRuns(history)
	c.JSON(http.StatusOK, result)
}

type taskPresentationPosition struct {
	createdAt pgtype.Timestamptz
	runID     string
}

// taskPresentationCursor decodes the creation time and Run ID of the last
// history item a page returned.
func taskPresentationCursor(taskID string, cursor *string) (taskPresentationPosition, bool) {
	if cursor == nil {
		return taskPresentationPosition{}, true
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*cursor)
	if err != nil {
		return taskPresentationPosition{}, false
	}
	parts := strings.Split(string(decoded), "\n")
	if len(parts) != 3 || parts[0] != taskID || parts[2] == "" {
		return taskPresentationPosition{}, false
	}
	micros, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || micros <= 0 {
		return taskPresentationPosition{}, false
	}
	return taskPresentationPosition{
		createdAt: pgtype.Timestamptz{Time: time.UnixMicro(micros).UTC(), Valid: true}, runID: parts[2],
	}, true
}

func taskPresentationRuns(rows []store.ListTaskRuntimePresentationRunsRow) []httpapi.RoomRunStatus {
	items := make([]httpapi.RoomRunStatus, 0, len(rows))
	for _, row := range rows {
		items = append(items, agentruntimestate.RoomRunStatus(agentruntimestate.RoomRunStatusFields{
			RunID: row.RunID, RoomID: row.RoomID, RunStatus: row.Status, Replied: row.Replied,
			AgentActorID: row.AgentActorID, AgentKind: row.AgentKind, AgentDisplayName: row.AgentDisplayName,
			EventOrdinal: row.EventOrdinal, StopReason: row.StopReason, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}))
	}
	return items
}
