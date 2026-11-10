package app

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestDatabasePoolConfigPreservesExplicitConnectionBudget(t *testing.T) {
	t.Parallel()

	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = "postgres://teamhub:teamhub@postgres.example/teamhub?pool_max_conns=7"
	})

	poolConfig, err := newDatabasePoolConfig(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if poolConfig.MaxConns != 7 {
		t.Fatalf("MaxConns = %d, want 7", poolConfig.MaxConns)
	}
}

func TestDatabasePoolConfigUsesSafeDefaultConnectionBudget(t *testing.T) {
	t.Parallel()

	poolConfig, err := newDatabasePoolConfig(config.ForTest(func(c *config.Config) {
		c.DatabaseURL = "postgres://teamhub:teamhub@postgres.example/teamhub"
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if poolConfig.MaxConns != defaultDatabaseMaxConnections {
		t.Fatalf("MaxConns = %d, want %d", poolConfig.MaxConns, defaultDatabaseMaxConnections)
	}
}

func TestDatabasePoolConfigRecyclesConnectionsByDefault(t *testing.T) {
	t.Parallel()

	poolConfig, err := newDatabasePoolConfig(config.ForTest(func(c *config.Config) {
		c.DatabaseURL = "postgres://teamhub:teamhub@postgres.example/teamhub"
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if poolConfig.MaxConnLifetime != defaultDatabaseMaxConnLifetime {
		t.Fatalf("MaxConnLifetime = %s, want %s", poolConfig.MaxConnLifetime, defaultDatabaseMaxConnLifetime)
	}
	if poolConfig.MaxConnLifetimeJitter != defaultDatabaseMaxConnLifetimeJitter {
		t.Fatalf("MaxConnLifetimeJitter = %s, want %s", poolConfig.MaxConnLifetimeJitter, defaultDatabaseMaxConnLifetimeJitter)
	}
	if poolConfig.MaxConnIdleTime != defaultDatabaseMaxConnIdleTime {
		t.Fatalf("MaxConnIdleTime = %s, want %s", poolConfig.MaxConnIdleTime, defaultDatabaseMaxConnIdleTime)
	}
	if poolConfig.MinConns != 0 {
		t.Fatalf("MinConns = %d, want 0", poolConfig.MinConns)
	}
	if poolConfig.ConnConfig.DefaultQueryExecMode != pgx.QueryExecModeCacheDescribe {
		t.Fatalf("DefaultQueryExecMode = %s, want %s", poolConfig.ConnConfig.DefaultQueryExecMode, pgx.QueryExecModeCacheDescribe)
	}
}

func TestDatabasePoolConfigPreservesExplicitConnectionRecycling(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		param string
		value string
		got   func(*pgxpool.Config) time.Duration
		want  time.Duration
	}{
		{"pool_max_conn_lifetime", "3h", func(c *pgxpool.Config) time.Duration { return c.MaxConnLifetime }, 3 * time.Hour},
		{"pool_max_conn_lifetime_jitter", "7s", func(c *pgxpool.Config) time.Duration { return c.MaxConnLifetimeJitter }, 7 * time.Second},
		{"pool_max_conn_idle_time", "45m", func(c *pgxpool.Config) time.Duration { return c.MaxConnIdleTime }, 45 * time.Minute},
	} {
		t.Run(test.param, func(t *testing.T) {
			t.Parallel()
			poolConfig, err := newDatabasePoolConfig(config.ForTest(func(c *config.Config) {
				c.DatabaseURL = "postgres://teamhub:teamhub@postgres.example/teamhub?" + test.param + "=" + test.value
			}), nil)
			if err != nil {
				t.Fatal(err)
			}
			if got := test.got(poolConfig); got != test.want {
				t.Fatalf("%s = %s, want %s", test.param, got, test.want)
			}
		})
	}
}

func TestDatabasePoolConfigPreservesExplicitQueryExecMode(t *testing.T) {
	t.Parallel()

	poolConfig, err := newDatabasePoolConfig(config.ForTest(func(c *config.Config) {
		c.DatabaseURL = "postgres://teamhub:teamhub@postgres.example/teamhub?default_query_exec_mode=cache_statement&statement_cache_capacity=64"
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if poolConfig.ConnConfig.DefaultQueryExecMode != pgx.QueryExecModeCacheStatement {
		t.Fatalf("DefaultQueryExecMode = %s, want %s", poolConfig.ConnConfig.DefaultQueryExecMode, pgx.QueryExecModeCacheStatement)
	}
	if poolConfig.ConnConfig.StatementCacheCapacity != 64 {
		t.Fatalf("StatementCacheCapacity = %d, want 64", poolConfig.ConnConfig.StatementCacheCapacity)
	}
}
