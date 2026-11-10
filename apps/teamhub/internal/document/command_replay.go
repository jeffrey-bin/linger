package document

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// lookupCommandRecord returns the account command record for key. A record
// stored for a different request hash is ErrIdempotencyConflict.
func lookupCommandRecord(ctx context.Context, db store.DBTX, accountID, operation, key string, hash []byte) (idempotency.Record, bool, error) {
	record, found, err := idempotency.Lookup(ctx, db, idempotency.AccountKey(accountID, operation, key), hash)
	if errors.Is(err, idempotency.ErrConflict) {
		return idempotency.Record{}, false, ErrIdempotencyConflict
	}
	return record, found, err
}
