package integration_test

import (
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestPersonalWikiProfileChangesPreserveRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	fixture := newUnifiedWikiDispatchCase(t, "profile-invalidation", &recordingWikiCandidateGenerator{},
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	before := assertPersonalWikiRefreshState(t, fixture, "refreshing")
	if _, err := fixture.pool.Exec(t.Context(), `
		INSERT INTO personal_profile_revisions(id,tenant_id,owner_actor_id,prompt_version,markdown,profile)
		VALUES('profile_invalidation_a','tenant_document_a','actor_human_a','invalidation-test','# First','{}'),
		      ('profile_invalidation_b','tenant_document_a','actor_human_a','invalidation-test','# Second','{}');
	`); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{
		`INSERT INTO personal_profile_currents(tenant_id,owner_actor_id,revision_id)
		 VALUES('tenant_document_a','actor_human_a','profile_invalidation_a')`,
		`UPDATE personal_profile_currents SET revision_id='profile_invalidation_b'
		 WHERE tenant_id='tenant_document_a' AND owner_actor_id='actor_human_a'`,
		`DELETE FROM personal_profile_currents
		 WHERE tenant_id='tenant_document_a' AND owner_actor_id='actor_human_a'`,
	} {
		if _, err := fixture.pool.Exec(t.Context(), mutation); err != nil {
			t.Fatal(err)
		}
		after := assertPersonalWikiRefreshState(t, fixture, "refreshing")
		if after.PublishedGeneration != before.PublishedGeneration || after.CurrentRevisionID != before.CurrentRevisionID ||
			after.LatestRefreshID != fixture.admission.ID {
			t.Fatalf("Profile mutation changed Wiki publication or refresh: before=%+v after=%+v", before, after)
		}
		var refreshState string
		if err := fixture.pool.QueryRow(t.Context(), `SELECT status FROM document_wiki_refreshes WHERE id=$1`,
			fixture.admission.ID).Scan(&refreshState); err != nil {
			t.Fatal(err)
		}
		if refreshState != "staging" {
			t.Fatalf("Profile mutation changed refresh status=%s", refreshState)
		}
	}
}
