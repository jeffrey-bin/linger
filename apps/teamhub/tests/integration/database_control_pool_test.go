package integration_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDatabaseControlPoolLifecycle(t *testing.T) {
	serialIntegrationTest(t, serialSuiteMeta)
	t.Run("reuses one bounded pool concurrently", testDatabaseControlPoolReusesOneBoundedPoolConcurrently)
	t.Run("concurrent waiter retries creation after failure", testDatabaseControlPoolConcurrentWaiterRetriesCreationAfterFailure)
	t.Run("closes once and cannot reopen", testDatabaseControlPoolClosesOnceAndCannotReopen)
	t.Run("closes after cleanup failure", testDatabaseControlPoolClosesAfterCleanupFailure)
}

func testDatabaseControlPoolReusesOneBoundedPoolConcurrently(t *testing.T) {
	suite := newTestDatabaseSuite()
	suite.controlConfig = mustParseControlConfig(t)
	suite.controlOnce.Do(func() {})

	control := &fakeDatabaseControl{}
	var factoryCalls atomic.Int32
	suite.newControlPool = func(_ context.Context, config *pgxpool.Config) (databaseControl, error) {
		factoryCalls.Add(1)
		if want := integrationControlPoolSize(); config.MaxConns != want {
			t.Fatalf("control pool MaxConns = %d, want %d", config.MaxConns, want)
		}
		return control, nil
	}

	const callers = 8
	results := make(chan databaseControl, callers)
	errors := make(chan error, callers)
	var workers sync.WaitGroup
	workers.Add(callers)
	for range callers {
		go func() {
			defer workers.Done()
			result, err := suite.testControlPool(context.Background())
			results <- result
			errors <- err
		}()
	}
	workers.Wait()
	close(results)
	close(errors)

	for err := range errors {
		if err != nil {
			t.Fatalf("get database control pool: %v", err)
		}
	}
	for result := range results {
		if result != control {
			t.Fatalf("control pool = %p, want reused %p", result, control)
		}
	}
	if got := factoryCalls.Load(); got != 1 {
		t.Fatalf("control pool factory calls = %d, want 1", got)
	}
}

func testDatabaseControlPoolConcurrentWaiterRetriesCreationAfterFailure(t *testing.T) {
	suite := newTestDatabaseSuite()
	suite.controlConfig = mustParseControlConfig(t)
	suite.controlOnce.Do(func() {})

	wantErr := errors.New("temporary pool failure")
	control := &fakeDatabaseControl{}
	var factoryCalls atomic.Int32
	firstFactoryStarted := make(chan struct{})
	releaseFirstFactory := make(chan struct{})
	suite.newControlPool = func(context.Context, *pgxpool.Config) (databaseControl, error) {
		if factoryCalls.Add(1) == 1 {
			close(firstFactoryStarted)
			<-releaseFirstFactory
			return nil, wantErr
		}
		return control, nil
	}

	type poolResult struct {
		control databaseControl
		err     error
	}
	results := make(chan poolResult, 2)
	go func() {
		got, err := suite.testControlPool(context.Background())
		results <- poolResult{control: got, err: err}
	}()
	<-firstFactoryStarted
	go func() {
		got, err := suite.testControlPool(context.Background())
		results <- poolResult{control: got, err: err}
	}()
	close(releaseFirstFactory)

	var failures, successes int
	for range 2 {
		result := <-results
		switch {
		case errors.Is(result.err, wantErr):
			failures++
		case result.err != nil:
			t.Fatalf("unexpected control pool error: %v", result.err)
		case result.control != control:
			t.Fatalf("retried control pool = %p, want %p", result.control, control)
		default:
			successes++
		}
	}
	if failures != 1 || successes != 1 {
		t.Fatalf("pool results failures=%d successes=%d, want 1/1", failures, successes)
	}
	if calls := factoryCalls.Load(); calls != 2 {
		t.Fatalf("control pool factory calls = %d, want 2", calls)
	}
}

func testDatabaseControlPoolClosesOnceAndCannotReopen(t *testing.T) {
	suite := newTestDatabaseSuite()
	suite.controlConfig = mustParseControlConfig(t)
	suite.controlOnce.Do(func() {})

	control := &fakeDatabaseControl{}
	suite.newControlPool = func(context.Context, *pgxpool.Config) (databaseControl, error) {
		return control, nil
	}
	if _, err := suite.testControlPool(context.Background()); err != nil {
		t.Fatalf("create database control pool: %v", err)
	}

	if err := suite.close(context.Background()); err != nil {
		t.Fatalf("close database suite: %v", err)
	}
	if err := suite.close(context.Background()); err != nil {
		t.Fatalf("close database suite twice: %v", err)
	}
	if got := control.closeCalls.Load(); got != 1 {
		t.Fatalf("control pool close calls = %d, want 1", got)
	}
	if _, err := suite.testControlPool(context.Background()); !errors.Is(err, errTestDatabaseSuiteClosed) {
		t.Fatalf("control pool after close error = %v, want %v", err, errTestDatabaseSuiteClosed)
	}
}

func testDatabaseControlPoolClosesAfterCleanupFailure(t *testing.T) {
	suite := newTestDatabaseSuite()
	suite.controlConfig = mustParseControlConfig(t)
	suite.controlOnce.Do(func() {})

	wantErr := errors.New("forced drop failure")
	control := &fakeDatabaseControl{execErr: wantErr}
	suite.newControlPool = func(context.Context, *pgxpool.Config) (databaseControl, error) {
		return control, nil
	}
	suite.registerDatabase("integration_cleanup_failure")

	err := suite.close(context.Background())
	if !errors.Is(err, wantErr) {
		t.Fatalf("close database suite error = %v, want %v", err, wantErr)
	}
	if got := control.closeCalls.Load(); got != 1 {
		t.Fatalf("control pool close calls = %d, want 1", got)
	}
}

type fakeDatabaseControl struct {
	closeCalls atomic.Int32
	execErr    error
}

func (control *fakeDatabaseControl) Exec(context.Context, string) error {
	return control.execErr
}

func (control *fakeDatabaseControl) Close() {
	control.closeCalls.Add(1)
}

func mustParseControlConfig(t *testing.T) *pgx.ConnConfig {
	t.Helper()
	config, err := pgx.ParseConfig("postgres://postgres@localhost/teamhub_test_control")
	if err != nil {
		t.Fatalf("parse control config: %v", err)
	}
	return config
}
