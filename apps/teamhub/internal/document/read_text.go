package document

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ReadText reads authorized current indexed text in one consistent snapshot.
// Empty text means extraction is not ready; it is never a permission fallback.
func (s *Service) ReadText(ctx context.Context, accountID, documentID string) (Document, string, error) {
	if accountID == "" || documentID == "" {
		return Document{}, "", ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Document{}, "", err
	}
	defer tx.Rollback(ctx)
	value, err := get(ctx, tx, accountID, documentID)
	if err != nil {
		return Document{}, "", err
	}
	var text string
	err = tx.QueryRow(ctx, `SELECT search_text FROM document_texts WHERE document_id=$1 AND status='ready'`, documentID).Scan(&text)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Document{}, "", err
	}
	return value, text, nil
}
