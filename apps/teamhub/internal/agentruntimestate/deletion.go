package agentruntimestate

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// DeletionSnapshot grants cleanup identity, never execution or Context creation.
type DeletionSnapshot struct {
	Registration store.GetAgentRuntimeRegistrationForRunnerByManagementIDRow
	Contexts     []Context
}

func (s *Service) ReadDeletionSnapshot(ctx context.Context, agentID string) (DeletionSnapshot, error) {
	if s == nil || s.pool == nil || strings.TrimSpace(agentID) == "" {
		return DeletionSnapshot{}, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return DeletionSnapshot{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	registration, err := queries.GetAgentRuntimeRegistrationForRunnerByManagementID(ctx, agentID)
	if isNoRows(err) || (err == nil && registration.Status != "revoked") {
		return DeletionSnapshot{}, ErrNotFound
	}
	if err != nil {
		return DeletionSnapshot{}, err
	}
	if !registration.AgentManagementID.Valid || registration.AgentManagementID.String != agentID {
		return DeletionSnapshot{}, ErrConflict
	}
	listed, err := queries.ListAgentExecutionContextsByManagementID(ctx, agentID)
	if err != nil {
		return DeletionSnapshot{}, err
	}
	rows := make([]contextRecord, 0, len(listed))
	for _, row := range listed {
		if row.TenantID != registration.TenantID || row.AgentActorID != registration.ActorID {
			return DeletionSnapshot{}, ErrConflict
		}
		rows = append(rows, contextRecord(row))
	}
	contexts, err := contextsFromRows(ctx, queries, rows)
	if err != nil {
		return DeletionSnapshot{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DeletionSnapshot{}, err
	}
	return DeletionSnapshot{Registration: registration, Contexts: contexts}, nil
}
