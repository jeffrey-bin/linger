package agentruntimestate

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Archive closes runtime authority without ending the Task execution generation.
// Only Contexts suspended by archive are eligible for unarchive restoration.
func ReconcileAlterEgoContextsForTaskArchive(ctx context.Context, queries *store.Queries, taskID string, archived bool) error {
	if queries == nil || strings.TrimSpace(taskID) == "" {
		return ErrInvalid
	}
	if !archived {
		_, err := queries.RestoreAlterEgoContextsAfterTaskArchive(ctx, taskID)
		return err
	}
	contextKeys, err := queries.SuspendAlterEgoContextsForTaskArchive(ctx, taskID)
	if err != nil {
		return err
	}
	for _, contextKey := range contextKeys {
		if _, err := queries.SettleAgentContextInputsForTaskArchive(ctx, contextKey); err != nil {
			return err
		}
		runIDs, err := queries.ListUnfinishedAgentContextLocalRuns(ctx, contextKey)
		if err != nil {
			return err
		}
		if _, err := TerminateLocalRuns(ctx, queries, runIDs, json.RawMessage(`{"type":"canceled","reason":"task_archived"}`)); err != nil {
			return err
		}
	}
	return nil
}
