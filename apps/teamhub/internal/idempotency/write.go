package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Result is the response of an idempotent write: the outcome it committed, or
// the stored outcome of an earlier attempt when Replay is set.
type Result struct {
	Status int
	Body   []byte
	Replay bool
}

// HashRequest digests a request for replay comparison. Callers pass a DTO or
// key set with stable types, because compatibility depends on a stable JSON
// representation.
func HashRequest(request any) []byte {
	encoded, err := json.Marshal(request)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(encoded)
	return digest[:]
}

// Replay returns the outcome committed for k as a replayed Result. Callers hold
// Lock first, so a waiting retry only sees a complete outcome. It reports
// ErrConflict when k was stored for a different request.
func Replay(ctx context.Context, db store.DBTX, k Key, hash []byte) (Result, bool, error) {
	record, found, err := Lookup(ctx, db, k, hash)
	if err != nil || !found {
		return Result{}, false, err
	}
	return Result{Status: record.Status, Body: record.Body, Replay: true}, true, nil
}

// Beginner opens the transaction an idempotent write runs in.
type Beginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// AccountWrite performs one account-level write in one transaction: lock the
// key, return a replay when one exists, otherwise run change and save its
// response with the business facts it committed.
func AccountWrite(ctx context.Context, db Beginner, accountID, operation, key string, request any, change func(*store.Queries) (string, int, []byte, error)) (Result, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx)
	k := AccountKey(accountID, operation, key)
	if err = Lock(ctx, tx, k); err != nil {
		return Result{}, err
	}
	requestHash := HashRequest(request)
	if replay, found, replayErr := Replay(ctx, tx, k, requestHash); replayErr != nil {
		return Result{}, replayErr
	} else if found {
		return replay, tx.Commit(ctx)
	}
	resourceID, status, body, err := change(store.New(tx))
	if err != nil {
		return Result{}, err
	}
	if body == nil {
		body = []byte{}
	}
	if err = Save(ctx, tx, k, requestHash, Record{ResourceID: resourceID, Status: status, Body: body}); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{Status: status, Body: body}, nil
}
