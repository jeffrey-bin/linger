package document

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type UpdateMetadataInput struct {
	AccountID, DocumentID, Title string
}

type UpdateMetadataResult struct {
	Document Document
	Changed  bool
}

func (s *Service) UpdateMetadata(ctx context.Context, input UpdateMetadataInput) (UpdateMetadataResult, error) {
	input.Title = strings.TrimSpace(input.Title)
	if input.AccountID == "" || input.DocumentID == "" || input.Title == "" || len(input.Title) > 255 {
		return UpdateMetadataResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return UpdateMetadataResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return UpdateMetadataResult{}, err
	}
	if !value.Capabilities.Manage {
		return UpdateMetadataResult{}, ErrNotFound
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, value.TenantID)
	if err != nil {
		return UpdateMetadataResult{}, err
	}
	var format, status, currentTitle string
	var hasDraft bool
	if err := tx.QueryRow(ctx, `SELECT document.format,document.status,document.title,
		EXISTS(SELECT 1 FROM document_bodies body WHERE body.document_id=document.id)
		FROM documents document WHERE document.id=$1 AND document.tenant_id=$2 FOR UPDATE`,
		input.DocumentID, value.TenantID).Scan(&format, &status, &currentTitle, &hasDraft); err != nil {
		return UpdateMetadataResult{}, err
	}
	if format == "blocknote" || hasDraft {
		return UpdateMetadataResult{}, ErrInvalidInput
	}
	if status != "active" {
		return UpdateMetadataResult{}, ErrNotFound
	}
	changed := currentTitle != input.Title
	if changed {
		command, err := tx.Exec(ctx, `UPDATE documents SET title=$2,updated_at=GREATEST(updated_at,clock_timestamp())
			WHERE id=$1 AND tenant_id=$3 AND title=$4 AND status='active'`, input.DocumentID,
			input.Title, value.TenantID, currentTitle)
		if err != nil {
			return UpdateMetadataResult{}, err
		}
		if command.RowsAffected() != 1 {
			return UpdateMetadataResult{}, ErrConflict
		}
		commandID := idgen.New("document_metadata_command")
		if err := appendLifecycleEvent(ctx, tx, value.TenantID, input.DocumentID, actorID,
			commandID, "metadata_command", "document.metadata_updated"); err != nil {
			return UpdateMetadataResult{}, err
		}
	}
	result, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return UpdateMetadataResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UpdateMetadataResult{}, err
	}
	return UpdateMetadataResult{Document: result, Changed: changed}, nil
}
