package integration_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sequence: concurrent inserters under READ COMMITTED and SERIALIZABLE get
// gap-free, unique sequences, and an idempotent replay consumes no number.
func TestDocumentEventLockOrderAllocatesGapFreeSequences(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	_, pool := newUnifiedDocumentFixture(t, "")

	var baseline int64
	if err := pool.QueryRow(ctx, `SELECT coalesce(max(sequence),0) FROM document_events WHERE document_id='document_human_a'`).Scan(&baseline); err != nil {
		t.Fatal(err)
	}

	const writers = 16
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		isolation := pgx.ReadCommitted
		if i%2 == 1 {
			isolation = pgx.Serializable
		}
		wg.Add(1)
		go func(eventID string, isolation pgx.TxIsoLevel) {
			defer wg.Done()
			errs <- appendLockOrderEventWithRetry(ctx, pool, isolation, eventID, "document_human_a")
		}(fmt.Sprintf("event_lock_order_seq_%02d", i), isolation)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent event insert: %v", err)
		}
	}

	rows, err := pool.Query(ctx, `SELECT sequence FROM document_events WHERE document_id='document_human_a' AND sequence>$1 ORDER BY sequence`, baseline)
	if err != nil {
		t.Fatal(err)
	}
	var sequences []int64
	for rows.Next() {
		var sequence int64
		if err := rows.Scan(&sequence); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		sequences = append(sequences, sequence)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(sequences) != writers {
		t.Fatalf("new sequences = %v, want %d events", sequences, writers)
	}
	for index, sequence := range sequences {
		if want := baseline + int64(index) + 1; sequence != want {
			t.Fatalf("new sequences = %v, want contiguous from %d", sequences, baseline+1)
		}
	}

	var lastSequence int64
	if err := pool.QueryRow(ctx, `SELECT last_sequence FROM document_event_sequences WHERE document_id='document_human_a'`).Scan(&lastSequence); err != nil {
		t.Fatal(err)
	}
	if want := baseline + writers; lastSequence != want {
		t.Fatalf("last_sequence = %d, want %d", lastSequence, want)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `INSERT INTO document_events(id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version)
		VALUES('event_lock_order_seq_00','tenant_document_a','document_human_a','document.draft_updated','actor_human_a','autosave_batch','event_lock_order_seq_00',1)
		ON CONFLICT (id) DO NOTHING`)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("idempotent replay affected %d rows, want 0", tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT last_sequence FROM document_event_sequences WHERE document_id='document_human_a'`).Scan(&lastSequence); err != nil {
		t.Fatal(err)
	}
	if want := baseline + writers; lastSequence != want {
		t.Fatalf("after replay last_sequence = %d, want %d", lastSequence, want)
	}
	// A duplicate id without ON CONFLICT still fails with a unique violation,
	// so callers that map 23505 to a conflict keep that behavior.
	_, err = pool.Exec(ctx, `INSERT INTO document_events(id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version)
		VALUES('event_lock_order_seq_00','tenant_document_a','document_human_a','document.draft_updated','actor_human_a','autosave_batch','event_lock_order_seq_00',1)`)
	var duplicate *pgconn.PgError
	if !errors.As(err, &duplicate) || duplicate.Code != "23505" {
		t.Fatalf("duplicate event id error = %v, want SQLSTATE 23505", err)
	}
	if err := pool.QueryRow(ctx, `SELECT last_sequence FROM document_event_sequences WHERE document_id='document_human_a'`).Scan(&lastSequence); err != nil {
		t.Fatal(err)
	}
	if want := baseline + writers; lastSequence != want {
		t.Fatalf("after duplicate insert last_sequence = %d, want %d", lastSequence, want)
	}
}

func appendLockOrderEventWithRetry(ctx context.Context, pool *pgxpool.Pool, isolation pgx.TxIsoLevel, eventID, documentID string) error {
	for attempt := 0; attempt < 100; attempt++ {
		err := func() error {
			tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: isolation})
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if err := insertLockOrderDocumentEvent(ctx, tx, eventID, documentID); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}()
		var pgErr *pgconn.PgError
		if err == nil || isolation != pgx.Serializable || !errors.As(err, &pgErr) || pgErr.Code != "40001" {
			return err
		}
	}
	return fmt.Errorf("event %s still failing serialization after retries", eventID)
}

func insertLockOrderDocumentEvent(ctx context.Context, tx pgx.Tx, eventID, documentID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO document_events(id,tenant_id,document_id,event_type,actor_id,resource_kind,resource_id,projection_version)
		VALUES($1,'tenant_document_a',$2,'document.draft_updated','actor_human_a','autosave_batch',$1,1)`, eventID, documentID)
	return err
}

type lockOrderHTTPResult struct {
	status int
	body   []byte
}

type lockOrderResult[T any] struct {
	value T
	err   error
}

func startLockOrderOperation[T any](run func() (T, error)) <-chan lockOrderResult[T] {
	results := make(chan lockOrderResult[T], 1)
	go func() {
		value, err := run()
		results <- lockOrderResult[T]{value: value, err: err}
	}()
	return results
}

func receiveLockOrderResult[T any](t *testing.T, results <-chan lockOrderResult[T], action string) lockOrderResult[T] {
	t.Helper()
	select {
	case result := <-results:
		return result
	case <-time.After(30 * time.Second):
		t.Fatalf("%s did not finish after the gate was released", action)
		return lockOrderResult[T]{}
	}
}

// awaitLockOrderOperationsWithoutCycle polls until both released operations have
// completed, failing on any blocking cycle among this database's backends. A
// real deadlock stays visible for deadlock_timeout before PostgreSQL breaks it,
// and autosave retries serialization failures, so a deadlock where autosave is
// the victim would otherwise pass unnoticed.
func awaitLockOrderOperationsWithoutCycle(t *testing.T, monitor *pgx.Conn, done ...func() bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		finished := true
		for _, isDone := range done {
			finished = finished && isDone()
		}
		assertNoLockOrderDeadlockCycle(t, monitor)
		if finished {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("released operations did not complete within 30s")
		case <-ticker.C:
		}
	}
}

// assertNoLockOrderDeadlockCycle fails if two backends of this database each
// block the other.
func assertNoLockOrderDeadlockCycle(t *testing.T, monitor *pgx.Conn) {
	t.Helper()
	rows, err := monitor.Query(t.Context(), `SELECT pid,pg_blocking_pids(pid) FROM pg_stat_activity
		WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	blockers := map[int32][]int32{}
	for rows.Next() {
		var pid int32
		var blocking []int32
		if err := rows.Scan(&pid, &blocking); err != nil {
			t.Fatal(err)
		}
		blockers[pid] = blocking
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for pid, blocking := range blockers {
		for _, blocker := range blocking {
			if slices.Contains(blockers[blocker], pid) {
				t.Fatalf("backends %d and %d block each other (deadlock cycle)", pid, blocker)
			}
		}
	}
}

// lockOrderDone reports whether a started operation has produced its result.
// The result channel is buffered, so the result stays available to receive.
func lockOrderDone[T any](results <-chan lockOrderResult[T]) func() bool {
	return func() bool { return len(results) > 0 }
}

func connectLockOrderMonitor(t *testing.T, env *testEnv) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), env.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(t.Context()) })
	return conn
}

// waitForLockOrderWaiter polls until a backend other than the gate and the
// excluded backend is blocked on a lock. When onDocument is set, it must be
// blocked on the Document advisory key. It returns that backend's pid.
func waitForLockOrderWaiter(
	t *testing.T,
	monitor *pgx.Conn,
	gatePID, excludedPID int,
	documentKey int64,
	onDocument bool,
) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		for _, pid := range listLockOrderWaiters(t, monitor, gatePID, excludedPID) {
			if !onDocument || backendWaitsOnDocumentKey(t, monitor, pid, documentKey) {
				return pid
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("no backend blocked on the Document lock within 30s (onDocument=%t)", onDocument)
		case <-ticker.C:
		}
	}
}

// listLockOrderWaiters returns the backends of the test database that are
// waiting on a lock, excluding the gate and one optional backend.
func listLockOrderWaiters(t *testing.T, monitor *pgx.Conn, gatePID, excludedPID int) []int {
	t.Helper()
	rows, err := monitor.Query(t.Context(), `SELECT pid FROM pg_stat_activity
		WHERE datname=current_database() AND pid<>$1 AND pid<>$2 AND wait_event_type='Lock'
		ORDER BY pid`, gatePID, excludedPID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var pids []int
	for rows.Next() {
		var pid int
		if err := rows.Scan(&pid); err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pid)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return pids
}

func backendWaitsOnDocumentKey(t *testing.T, monitor *pgx.Conn, pid int, documentKey int64) bool {
	t.Helper()
	var waits bool
	if err := monitor.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_locks
		WHERE pid=$1 AND NOT granted AND locktype='advisory'
		  AND (database IS NULL OR database=(SELECT oid FROM pg_database WHERE datname=current_database()))
		  AND classid::bigint=(($2::bigint>>32)&4294967295)
		  AND objid::bigint=($2::bigint&4294967295))`, pid, documentKey).Scan(&waits); err != nil {
		t.Fatal(err)
	}
	return waits
}
