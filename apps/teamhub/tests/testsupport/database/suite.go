package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/demodata"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
)

// Suite owns one migrated identity template and private per-test clones.
// The zero value is usable; call Run from the package's TestMain for cleanup.
type Suite struct {
	once       sync.Once
	err        error
	control    *pgxpool.Pool
	controlURL string
	template   string
	mu         sync.Mutex
	databases  map[string]bool

	cleanups    sync.WaitGroup
	cleanupErrs []error
}

// Pool returns a migrated, identity-seeded database owned by this test.
func (suite *Suite) Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("integration tests require the managed test database runner")
	}
	suite.once.Do(func() { suite.err = suite.prepare(t.Context()) })
	if suite.err != nil {
		t.Fatal(suite.err)
	}
	name, err := databaseName()
	if err != nil {
		t.Fatal(err)
	}
	// Own cleanup before CREATE, including an ambiguous server outcome.
	suite.mu.Lock()
	suite.databases[name] = true
	suite.mu.Unlock()
	// Drop in the background; Run waits and reports failures.
	t.Cleanup(func() {
		suite.cleanups.Add(1)
		go func() {
			defer suite.cleanups.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := suite.drop(ctx, name); err != nil {
				suite.mu.Lock()
				suite.cleanupErrs = append(suite.cleanupErrs, fmt.Errorf("clean isolated database %s: %w", name, err))
				suite.mu.Unlock()
			}
		}()
	})
	if _, err := suite.control.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE "+pgx.Identifier{suite.template}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	databaseURL, err := WithDatabase(suite.controlURL, name)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func (suite *Suite) prepare(ctx context.Context) error {
	config, err := ControlConfig(ctx)
	if err != nil {
		return err
	}
	suite.controlURL = config.ConnString()
	poolConfig, err := pgxpool.ParseConfig(suite.controlURL)
	if err != nil {
		return err
	}
	poolConfig.MaxConns = 2 // a background DROP must not block the next CREATE
	suite.control, err = pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return err
	}
	suite.databases = make(map[string]bool)
	suite.template, err = databaseName()
	if err != nil {
		return err
	}
	suite.databases[suite.template] = true
	if _, err := suite.control.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{suite.template}.Sanitize()); err != nil {
		return err
	}
	templateURL, err := WithDatabase(suite.controlURL, suite.template)
	if err != nil {
		return err
	}
	if err := migrations.Up(ctx, templateURL); err != nil {
		return err
	}
	if err := demodata.SeedIdentities(ctx, templateURL); err != nil {
		return err
	}
	_, err = suite.control.Exec(ctx, "ALTER DATABASE "+pgx.Identifier{suite.template}.Sanitize()+" WITH ALLOW_CONNECTIONS false")
	return err
}

// Run makes failed cleanup fail the package, and also closes a partial template.
func (suite *Suite) Run(m *testing.M) int {
	exitCode := m.Run()
	suite.cleanups.Wait()
	if suite.control == nil {
		return exitCode
	}
	defer suite.control.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	suite.mu.Lock()
	cleanupErrs := suite.cleanupErrs
	suite.mu.Unlock()
	for _, err := range cleanupErrs {
		fmt.Fprintf(os.Stderr, "FAIL: %v\n", err)
		exitCode = 1
	}
	suite.mu.Lock()
	names := make([]string, 0, len(suite.databases))
	for name := range suite.databases {
		names = append(names, name)
	}
	suite.mu.Unlock()
	for _, name := range names {
		if err := suite.drop(ctx, name); err != nil {
			fmt.Fprintf(os.Stderr, "FAIL: clean isolated database suite: %v\n", err)
			exitCode = 1
		}
	}
	return exitCode
}

func (suite *Suite) drop(ctx context.Context, name string) error {
	if _, err := suite.control.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
		return err
	}
	suite.mu.Lock()
	delete(suite.databases, name)
	suite.mu.Unlock()
	return nil
}

func databaseName() (string, error) {
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return "teamhub_test_business_" + hex.EncodeToString(random[:]), nil
}
