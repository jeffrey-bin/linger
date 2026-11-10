package demodata

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
)

// SeedIdentities writes the fixed identity used only by local demos and
// isolated tests: one deployment owner Human, one tenant, and one general Agent.
// A deployment has exactly one Human, so the seed never adds a second one.
func SeedIdentities(ctx context.Context, databaseURL string) error {
	return seedIdentities(ctx, databaseURL, true)
}

// SeedHumanIdentities writes the local Human identity without creating a preset general Agent.
func SeedHumanIdentities(ctx context.Context, databaseURL string) error {
	return seedIdentities(ctx, databaseURL, false)
}

func seedIdentities(ctx context.Context, databaseURL string, includeOfficialAgents bool) error {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	accounts := []struct{ id, email, password string }{
		{"account_alice", "alice@example.com", "teamhub-dev-alice"},
	}
	for _, seed := range accounts {
		var exists bool
		if err := tx.QueryRow(ctx, "select exists(select 1 from accounts where id=$1)", seed.id).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		hash, err := account.HashPassword(seed.password)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "insert into accounts(id, email, password_hash) values($1,$2,$3)", seed.id, seed.email, hash); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		insert into actors(id, tenant_id, kind, display_name, account_id, handle) values
		('actor_acme_alice', 'tenant_acme', 'human', 'alice', 'account_alice', null)
			on conflict (id) do nothing`); err != nil {
		return err
	}
	if !includeOfficialAgents {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
		insert into actors(id, tenant_id, kind, display_name, account_id, handle) values
		('actor_acme_official', 'tenant_acme', 'agent', '@official', null, '@official')
			on conflict (id) do nothing`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		insert into agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id,visibility_scope
		) values
		('actor_acme_official','tenant_acme','agent-management-acme-official','active',
		 'Participate in TeamHub development Rooms.','gpt-5','actor_acme_alice',
		 'computer_acme_alice','codex','grant_files','workspace')
		on conflict (actor_id) do nothing`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
