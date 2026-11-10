package integration_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/demodata"
)

func TestDevelopmentHumanIdentitySeedCreatesOneHumanWithoutAgents(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabaseWithoutSkills(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(t.Context(), "TRUNCATE accounts,actors CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := demodata.SeedHumanIdentities(t.Context(), databaseURL); err != nil {
		t.Fatal(err)
	}

	var humans, agents int
	if err := pool.QueryRow(t.Context(), "select count(*) from actors where kind='human'").Scan(&humans); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), "select count(*) from actors where kind='agent'").Scan(&agents); err != nil {
		t.Fatal(err)
	}
	if humans != 1 || agents != 0 {
		t.Fatalf("seeded Humans=%d Agents=%d want 1,0", humans, agents)
	}
}

func TestE2EIdentitySeedCreatesAnIsolatedOwnerWithoutBusinessResults(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabaseWithoutSkills(t)
	config := demodata.E2EIdentityConfig{
		Enabled:     true,
		RunID:       "cards-files-20260823",
		Email:       "cards-files-20260823@example.test",
		Password:    "local-e2e-password",
		DisplayName: "Conversation Audit",
	}
	first, err := demodata.SeedE2EIdentity(t.Context(), databaseURL, config)
	if err != nil {
		t.Fatal(err)
	}
	second, err := demodata.SeedE2EIdentity(t.Context(), databaseURL, config)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("repeated E2E identity seed changed result: first=%+v second=%+v", first, second)
	}
	conflicting := config
	conflicting.DisplayName = "Different Audit Identity"
	if _, err := demodata.SeedE2EIdentity(t.Context(), databaseURL, conflicting); err == nil {
		t.Fatal("E2E identity seed accepted conflicting display name")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var accountID, email, passwordHash string
	if err := pool.QueryRow(t.Context(), `select id,email,password_hash from accounts where id=$1`, first.AccountID).Scan(&accountID, &email, &passwordHash); err != nil {
		t.Fatal(err)
	}
	if email != config.Email {
		t.Fatalf("seeded email=%q want %q", email, config.Email)
	}
	verified, err := account.VerifyPassword(config.Password, passwordHash)
	if err != nil {
		t.Fatal(err)
	}
	if !verified {
		t.Fatal("seeded password hash does not verify")
	}

	var actorKind string
	if err := pool.QueryRow(t.Context(), `select kind from actors where id=$1 and tenant_id=$2 and account_id=$3`, first.ActorID, first.TenantID, first.AccountID).Scan(&actorKind); err != nil {
		t.Fatal(err)
	}
	if actorKind != "human" {
		t.Fatalf("seeded actor kind=%q", actorKind)
	}

	for table, want := range map[string]int{"messages": 0, "rooms": 0, "message_cards": 0} {
		var count int
		if err := pool.QueryRow(t.Context(), "select count(*) from "+table).Scan(&count); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if count != want {
			t.Fatalf("seeded %s=%d want %d", table, count, want)
		}
	}
}
