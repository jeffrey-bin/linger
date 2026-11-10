package document

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type UpdateDraftTitleInput struct {
	AccountID, DocumentID, Title string
}

type UpdateDraftTitleResult struct {
	Document Document
	Changed  bool
}

// UpdateDraftTitle renames a native Document. The title lives only in
// documents.title, so renaming leaves the body and its sequence alone.
func (s *Service) UpdateDraftTitle(ctx context.Context, input UpdateDraftTitleInput) (UpdateDraftTitleResult, error) {
	input.Title = strings.TrimSpace(input.Title)
	if input.AccountID == "" || input.DocumentID == "" || input.Title == "" || len(input.Title) > 255 {
		return UpdateDraftTitleResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return UpdateDraftTitleResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return UpdateDraftTitleResult{}, err
	}
	if !value.Capabilities.Write || value.DraftCapability != "write" {
		return UpdateDraftTitleResult{}, ErrNotFound
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, value.TenantID)
	if err != nil {
		return UpdateDraftTitleResult{}, err
	}
	var currentTitle string
	if err := tx.QueryRow(ctx, `SELECT title FROM documents WHERE id=$1 AND tenant_id=$2 AND status='active'
		FOR NO KEY UPDATE`, input.DocumentID, value.TenantID).Scan(&currentTitle); errors.Is(err, pgx.ErrNoRows) {
		return UpdateDraftTitleResult{}, ErrNotFound
	} else if err != nil {
		return UpdateDraftTitleResult{}, err
	}
	changed := currentTitle != input.Title
	if changed {
		if err := setDocumentTitleTx(ctx, tx, value.TenantID, input.DocumentID, actorID, input.Title); err != nil {
			return UpdateDraftTitleResult{}, err
		}
	}
	result, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return UpdateDraftTitleResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UpdateDraftTitleResult{}, err
	}
	return UpdateDraftTitleResult{Document: result, Changed: changed}, nil
}

// setDocumentTitleTx renames a Document and emits its one title event.
func setDocumentTitleTx(ctx context.Context, tx pgx.Tx, tenantID, documentID, actorID, title string) error {
	if _, err := tx.Exec(ctx, `UPDATE documents SET title=$3,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$2`, documentID, tenantID, title); err != nil {
		return err
	}
	commandID := uuid.NewString()
	return appendDocumentEvent(ctx, tx, tenantID, documentID, actorID, "document_event_title_"+commandID,
		"title_command", commandID, "document.title_updated")
}
