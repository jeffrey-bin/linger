package document

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

type OpenResult struct {
	Document       Document
	Credential     *CollaborationCredential
	CurrentVersion *Version
}

// Open reads metadata and issues a fresh session under the same document lock.
// The token carries the permission count read under that lock.
func (s *Service) Open(ctx context.Context, input IssueCollaborationCredentialInput) (OpenResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.ExpiresAt.IsZero() {
		return OpenResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return OpenResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	// Serialize credential issuance and revocation without blocking the KEY SHARE
	// foreign-key check of Get's concurrent recent-open insert. FOR UPDATE would
	// wait on that insert while its transaction waits on this Document lock.
	if err := tx.QueryRow(ctx, `SELECT id FROM documents WHERE id=$1 FOR NO KEY UPDATE`, input.DocumentID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return OpenResult{}, ErrNotFound
		}
		return OpenResult{}, err
	}
	value, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return OpenResult{}, err
	}
	result := OpenResult{Document: value}
	if value.Format == "blocknote" && value.RepresentationFormat != "html" && value.DraftCapability != "none" {
		mode := "read"
		if value.DraftCapability == "write" {
			mode = "write"
		}
		credential, err := s.issueCollaborationCredentialTx(ctx, tx, input, mode, &value)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				if commitErr := tx.Commit(ctx); commitErr != nil {
					return OpenResult{}, commitErr
				}
			}
			return OpenResult{}, err
		}
		result.Credential = &credential
	}
	// File previews select their renderer from this Version, so return it with
	// the same read decision that loadAccessibleVersion applies to content.
	if (value.Format != "blocknote" || value.RepresentationFormat == "html") &&
		value.Status == "active" && value.Capabilities.Read && value.CurrentVersion != nil {
		version, err := getVersionTx(ctx, tx, value.CurrentVersion.ID)
		if err != nil {
			return OpenResult{}, fmt.Errorf("read current Version %s: %w", value.CurrentVersion.ID, err)
		}
		if version.ID != value.CurrentVersion.ID || version.DocumentID != value.ID {
			return OpenResult{}, fmt.Errorf("current Version %s does not belong to Document %s", version.ID, value.ID)
		}
		result.CurrentVersion = &version
	}
	if err := upsertRecentOpen(ctx, tx, value.ID); err != nil {
		return OpenResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return OpenResult{}, err
	}
	return result, nil
}
