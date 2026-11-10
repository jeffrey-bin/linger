package agentauth

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Authorizer resolves an Agent credential for one operation, optionally in
// the caller's transaction. Service implements it.
type Authorizer interface {
	Authorize(ctx context.Context, token, action string) (Authorization, error)
	AuthorizeInTx(ctx context.Context, tx pgx.Tx, token, action string) (Authorization, error)
}
