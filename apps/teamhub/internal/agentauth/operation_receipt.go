// Business operation receipts are recorded independently of credentials'
// rotation and internal execution lifecycles.

package agentauth

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

// ErrReceiptConflict reports an operation key reused for a different request.
var ErrReceiptConflict = idempotency.ErrConflict

type Receipt struct {
	ResourceID string
	Body       []byte
}

// LookupReceipt locks the stable identity before reading, so callers can commit
// the mutation and its receipt atomically in this same transaction.
func LookupReceipt(ctx context.Context, tx pgx.Tx, p *agentcredential.Principal, operation, id string, hash []byte) (Receipt, bool, error) {
	key := idempotency.AgentKey(p.AgentActorID, operation, id)
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return Receipt{}, false, err
	}
	record, found, err := idempotency.Lookup(ctx, tx, key, hash)
	if err != nil || !found {
		return Receipt{}, false, err
	}
	return Receipt{ResourceID: record.ResourceID, Body: record.Body}, true, nil
}

// SaveReceipt records the receipt with the credential that issued it, for audit.
func SaveReceipt(ctx context.Context, tx pgx.Tx, p *agentcredential.Principal, operation, id string, hash []byte, r Receipt) error {
	return idempotency.Save(ctx, tx, idempotency.AgentKey(p.AgentActorID, operation, id), hash, idempotency.Record{
		ResourceID: r.ResourceID, Status: http.StatusOK, Body: r.Body, CredentialID: p.CredentialID,
	})
}
