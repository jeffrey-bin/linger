package integration_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// probeDatabaseControl replaces the control pool so lifecycle tests observe
// CREATE and DROP statements without a PostgreSQL server.
type probeDatabaseControl struct {
	execute func(context.Context, string) error
}

func (control *probeDatabaseControl) Exec(ctx context.Context, statement string) error {
	return control.execute(ctx, statement)
}

func (control *probeDatabaseControl) Close() {}

func probeSuite(t *testing.T, control databaseControl) *testDatabaseSuite {
	t.Helper()
	suite := newTestDatabaseSuite()
	suite.controlOnce.Do(func() {})
	suite.templateOnce.Do(func() {})
	suite.controlConfig = mustParseControlConfig(t)
	suite.controlPool = control
	suite.templateName = "sealed"
	return suite
}

func TestDatabaseLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("concurrent clones get distinct databases and close drops all", func(t *testing.T) {
		const callers = 8
		var mu sync.Mutex
		created, dropped := map[string]bool{}, map[string]bool{}
		control := &probeDatabaseControl{execute: func(_ context.Context, statement string) error {
			mu.Lock()
			defer mu.Unlock()
			if name, ok := strings.CutPrefix(statement, "create database "); ok {
				created[strings.Trim(strings.Split(name, " template ")[0], `"`)] = true
			}
			if name, ok := strings.CutPrefix(statement, "drop database if exists "); ok {
				dropped[strings.Trim(strings.TrimSuffix(name, " with (force)"), `"`)] = true
			}
			return nil
		}}
		suite := probeSuite(t, control)
		urls := make(chan string, callers)
		var workers sync.WaitGroup
		for range callers {
			workers.Add(1)
			go func() {
				defer workers.Done()
				url, err := suite.cloneDatabase(context.Background(), "concurrent")
				if err != nil {
					t.Errorf("concurrent clone failed: %v", err)
					return
				}
				urls <- url
			}()
		}
		workers.Wait()
		close(urls)
		seen := map[string]bool{}
		for url := range urls {
			if seen[url] {
				t.Errorf("concurrent clones shared database %s", url)
			}
			seen[url] = true
		}
		if len(seen) != callers {
			t.Errorf("concurrent clones returned %d distinct databases, want %d", len(seen), callers)
		}
		if err := suite.close(context.Background()); err != nil {
			t.Errorf("close after concurrent clones: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		for name := range created {
			if !dropped[name] {
				t.Errorf("created clone %s was not dropped on close", name)
			}
		}
		if len(suite.databases) != 0 {
			t.Error("registered clones remain after close")
		}
	})
	t.Run("failed CREATE with ambiguous server outcome is still cleaned", func(t *testing.T) {
		failure := errors.New("connection lost after CREATE")
		var catalogMu sync.Mutex
		catalog := make(map[string]bool)
		control := &probeDatabaseControl{execute: func(_ context.Context, statement string) error {
			name := strings.Split(statement, "\"")[1]
			catalogMu.Lock()
			defer catalogMu.Unlock()
			if strings.HasPrefix(statement, "create database") {
				catalog[name] = true
				return failure
			}
			delete(catalog, name)
			return nil
		}}
		suite := probeSuite(t, control)
		if _, err := suite.cloneDatabase(context.Background(), "failed"); !errors.Is(err, failure) {
			t.Errorf("clone error=%v, want original CREATE failure", err)
		}
		if err := suite.close(context.Background()); err != nil {
			t.Errorf("close after failed CREATE: %v", err)
		}
		catalogMu.Lock()
		defer catalogMu.Unlock()
		if len(catalog) != 0 {
			t.Errorf("failed CREATE left %d untracked databases", len(catalog))
		}
	})
	t.Run("cleanup failure stays registered until close retries", func(t *testing.T) {
		failure := errors.New("injected DROP failure")
		var attempts atomic.Int32
		control := &probeDatabaseControl{execute: func(context.Context, string) error {
			if attempts.Add(1) == 1 {
				return failure
			}
			return nil
		}}
		suite := probeSuite(t, control)
		suite.registerDatabase("owned")
		if err := suite.cleanupDatabase(context.Background(), "owned"); !errors.Is(err, failure) {
			t.Fatalf("cleanup error=%v, want original DROP failure", err)
		}
		if _, registered := suite.databases["owned"]; !registered {
			t.Fatal("failed cleanup released ownership before the database was dropped")
		}
		if err := suite.close(context.Background()); err != nil {
			t.Errorf("close retry after failed cleanup: %v", err)
		}
		if len(suite.databases) != 0 {
			t.Error("registered databases remain after close retry")
		}
	})
}
