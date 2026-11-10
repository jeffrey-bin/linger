package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

func commandReplayKey() idempotency.Key {
	return idempotency.Key{Scope: "actor:actor_acme_alice", Operation: "create:tenant_acme", Key: "command-replay-key"}
}

func commandReplayHash(request string) []byte {
	digest := sha256.Sum256([]byte(request))
	return digest[:]
}

// commandReplayOnce follows the caller pattern: Lock, Lookup, then run and Save
// in the same transaction.
func commandReplayOnce(ctx context.Context, tx pgx.Tx, hash []byte, run func() (idempotency.Record, error)) (idempotency.Record, bool, error) {
	k := commandReplayKey()
	if err := idempotency.Lock(ctx, tx, k); err != nil {
		return idempotency.Record{}, false, err
	}
	if record, found, err := idempotency.Lookup(ctx, tx, k, hash); err != nil || found {
		return record, found, err
	}
	record, err := run()
	if err != nil {
		return idempotency.Record{}, false, err
	}
	return record, false, idempotency.Save(ctx, tx, k, hash, record)
}

func runCommandReplayTx(ctx context.Context, pool *pgxpool.Pool, hash []byte, run func() (idempotency.Record, error)) (idempotency.Record, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return idempotency.Record{}, false, err
	}
	defer tx.Rollback(ctx)
	record, replayed, err := commandReplayOnce(ctx, tx, hash, run)
	if err != nil {
		return record, replayed, err
	}
	return record, replayed, tx.Commit(ctx)
}

func TestCommandReplayReturnsStoredRecordAndRejectsReuse(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatalf("open command replay pool: %v", err)
	}
	defer pool.Close()

	stored := idempotency.Record{ResourceID: "workitem_1", Status: 201, Body: []byte(`{"id":"workitem_1"}`)}
	runs := 0
	record, replayed, err := runCommandReplayTx(ctx, pool, commandReplayHash("request-a"), func() (idempotency.Record, error) {
		runs++
		return stored, nil
	})
	if err != nil || replayed || runs != 1 || record.ResourceID != stored.ResourceID || record.Status != stored.Status || !bytes.Equal(record.Body, stored.Body) {
		t.Fatalf("first command replay record=%+v replayed=%v runs=%d err=%v", record, replayed, runs, err)
	}

	record, replayed, err = runCommandReplayTx(ctx, pool, commandReplayHash("request-a"), func() (idempotency.Record, error) {
		runs++
		return idempotency.Record{}, errors.New("run must not execute on replay")
	})
	if err != nil || !replayed || runs != 1 || record.ResourceID != stored.ResourceID || record.Status != stored.Status || !bytes.Equal(record.Body, stored.Body) {
		t.Fatalf("replayed command record=%+v replayed=%v runs=%d err=%v", record, replayed, runs, err)
	}

	_, _, err = runCommandReplayTx(ctx, pool, commandReplayHash("request-b"), func() (idempotency.Record, error) {
		runs++
		return stored, nil
	})
	if !errors.Is(err, idempotency.ErrConflict) || runs != 1 {
		t.Fatalf("reused command key err=%v runs=%d want ErrConflict", err, runs)
	}
}

func TestCommandReplayRollbackLeavesNoRecord(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatalf("open command replay pool: %v", err)
	}
	defer pool.Close()

	runs := 0
	run := func() (idempotency.Record, error) {
		runs++
		return idempotency.Record{ResourceID: "workitem_2", Status: 201, Body: []byte(`{}`)}, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin rolled-back command transaction: %v", err)
	}
	if _, replayed, err := commandReplayOnce(ctx, tx, commandReplayHash("request-a"), run); err != nil || replayed {
		t.Fatalf("rolled-back command replayed=%v err=%v", replayed, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback command transaction: %v", err)
	}

	_, replayed, err := runCommandReplayTx(ctx, pool, commandReplayHash("request-a"), run)
	if err != nil || replayed || runs != 2 {
		t.Fatalf("command after rollback replayed=%v runs=%d err=%v want run again", replayed, runs, err)
	}
}

func TestCommandReplayConcurrentSameKeyRunsOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatalf("open command replay pool: %v", err)
	}
	defer pool.Close()

	runs := 0
	firstTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin first command transaction: %v", err)
	}
	defer firstTx.Rollback(ctx)
	if _, replayed, err := commandReplayOnce(ctx, firstTx, commandReplayHash("request-a"), func() (idempotency.Record, error) {
		runs++
		return idempotency.Record{ResourceID: "workitem_3", Status: 201, Body: []byte(`{}`)}, nil
	}); err != nil || replayed {
		t.Fatalf("first concurrent command replayed=%v err=%v", replayed, err)
	}

	type outcome struct {
		replayed bool
		err      error
	}
	second := make(chan outcome, 1)
	go func() {
		_, replayed, err := runCommandReplayTx(ctx, pool, commandReplayHash("request-a"), func() (idempotency.Record, error) {
			runs++
			return idempotency.Record{}, errors.New("second attempt must wait and replay")
		})
		second <- outcome{replayed: replayed, err: err}
	}()
	select {
	case result := <-second:
		t.Fatalf("second attempt finished before the first transaction committed: replayed=%v err=%v", result.replayed, result.err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := firstTx.Commit(ctx); err != nil {
		t.Fatalf("commit first command transaction: %v", err)
	}
	select {
	case result := <-second:
		if result.err != nil || !result.replayed || runs != 1 {
			t.Fatalf("second concurrent command replayed=%v runs=%d err=%v", result.replayed, runs, result.err)
		}
	case <-ctx.Done():
		t.Fatalf("second attempt did not finish after the first transaction committed: %v", ctx.Err())
	}
}

func TestCommandReplayCompletesOnlyReservedRecords(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatalf("open command replay pool: %v", err)
	}
	defer pool.Close()

	reserved := idempotency.Key{Scope: "account:account_acme_alice", Operation: "deleteRoom:room_1", Key: "reserved-command"}
	accepted := idempotency.Key{Scope: "account:account_acme_alice", Operation: "document.wiki.refresh", Key: "accepted-command"}
	hash := commandReplayHash("request-a")
	inTx := func(run func(pgx.Tx) error) error {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := run(tx); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := inTx(func(tx pgx.Tx) error {
		if err := idempotency.Reserve(ctx, tx, reserved, hash, idempotency.Record{ResourceID: "room_1", Status: 202, Body: []byte{}}); err != nil {
			return err
		}
		// A final 202 is a completed outcome, not unfinished work.
		return idempotency.Save(ctx, tx, accepted, hash, idempotency.Record{ResourceID: "wiki_1", Status: 202, Body: []byte(`{}`)})
	}); err != nil {
		t.Fatalf("store commands: %v", err)
	}
	if record, found, err := idempotency.Lookup(ctx, pool, reserved, hash); err != nil || !found || !record.Reserved || record.Status != 202 {
		t.Fatalf("reserved command record=%+v found=%v err=%v", record, found, err)
	}
	if err := inTx(func(tx pgx.Tx) error {
		if err := idempotency.DeleteReserved(ctx, tx, accepted); err != nil {
			return err
		}
		return idempotency.Complete(ctx, tx, accepted, idempotency.Record{ResourceID: "wiki_1", Status: 200, Body: []byte(`{}`)})
	}); !errors.Is(err, idempotency.ErrNotPending) {
		t.Fatalf("complete a final 202 err=%v want ErrNotPending", err)
	}
	if record, found, err := idempotency.Lookup(ctx, pool, accepted, hash); err != nil || !found || record.Reserved || record.Status != 202 {
		t.Fatalf("final 202 changed: record=%+v found=%v err=%v", record, found, err)
	}
	if err := inTx(func(tx pgx.Tx) error {
		return idempotency.Complete(ctx, tx, reserved, idempotency.Record{ResourceID: "room_1", Status: 204, Body: []byte{}})
	}); err != nil {
		t.Fatalf("complete reserved command: %v", err)
	}
	if record, found, err := idempotency.Lookup(ctx, pool, reserved, hash); err != nil || !found || record.Reserved || record.Status != 204 {
		t.Fatalf("completed command record=%+v found=%v err=%v", record, found, err)
	}
}
