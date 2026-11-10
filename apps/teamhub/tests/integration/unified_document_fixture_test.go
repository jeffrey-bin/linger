package integration_test

import (
	"database/sql"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"
	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/database"
)

// newUnifiedDocumentFixture keeps each caller's database and connections private.
// Only immutable seed SQL is shared. Seed the complete prerequisite state in one
// round trip; test actions still use the ordinary production query protocol.
func newUnifiedDocumentFixture(t *testing.T, extraSQL string, arguments ...any) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	return newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL+unifiedDocumentContextFixtureSQL+extraSQL, arguments...)
}

// Wiki persistence tests need an owner and Wiki, without Room or Work Item setup.
// Sources and import state are prepared by the caller for the boundary it tests.
func newUnifiedWikiFixture(t *testing.T, extraSQL string, arguments ...any) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	return newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL+`
		INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES('wiki_document_a','tenant_document_a','actor_human_a');
	`+extraSQL, arguments...)
}

func newUnifiedDocumentDatabase(t *testing.T, seedSQL string, arguments ...any) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedArguments := append([]any{pgx.QueryExecModeSimpleProtocol}, arguments...)
	_, seedErr := pool.Exec(t.Context(), seedSQL, seedArguments...)
	if seedErr != nil {
		t.Fatalf("seed Document fixture: %v", seedErr)
	}
	return database.SQL(t, pool), pool
}

const unifiedDocumentIdentityFixtureSQL = documentfixture.IdentitySQL
const unifiedDocumentContextFixtureSQL = documentfixture.ContextSQL

var insertUnifiedDocumentIdentityFixture = documentfixture.InsertIdentity
var insertUnifiedDocumentContextFixture = documentfixture.InsertContext

// issueAgentPrincipal authenticates a fresh managed credential for an Agent.
// A current Agent credential is the only authority an Agent document write
// accepts.
func issueAgentPrincipal(t *testing.T, pool *pgxpool.Pool, agentID string) *agentcredential.Principal {
	t.Helper()
	issued, err := agentcredential.New(pool).IssueManaged(t.Context(), agentID, "document test")
	if err != nil {
		t.Fatal(err)
	}
	principal, err := agentcredential.Authenticate(t.Context(), pool, issued.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	return &principal
}
