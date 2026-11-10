package integration_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestPersonalWikiRefreshFreezesUnifiedInputSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &blockingUnifiedWikiGenerator{
		started: make(chan document.WikiCandidateGenerationRequest, 1),
		release: make(chan struct{}),
	}
	released := false
	t.Cleanup(func() {
		if !released {
			close(generator.release)
		}
	})
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	_, sourceDocumentID, frozenVersionID := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	second := uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-source-second-"+suffix,
		"second.txt", "plain_text", "text/plain", []byte("second frozen source"))

	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.Status != "accepted" || accepted.RefreshID == "" {
		t.Fatalf("refresh admission status=%d body=%s", status, body)
	}

	var request document.WikiCandidateGenerationRequest
	select {
	case request = <-generator.started:
	case <-time.After(5 * time.Second):
		t.Fatal("candidate generator did not receive frozen source request")
	}
	replacementContent := []byte("replacement source after refresh admission")
	status, _, body = requestUnifiedDocumentVersionUpload(t, env, alice, sourceDocumentID,
		"wiki-source-replacement-"+suffix, map[string]string{
			"expected_current_version_id": frozenVersionID,
			"filename":                    "wiki-source.txt",
			"representation_format":       "plain_text",
			"media_type":                  "text/plain",
		}, "wiki-source.txt", replacementContent)
	var replacement struct {
		ID string `json:"id"`
	}
	decode(t, body, &replacement)
	if status != http.StatusCreated || replacement.ID == "" || replacement.ID == frozenVersionID {
		t.Fatalf("replacement status=%d body=%s", status, body)
	}
	want := map[string]string{
		sourceDocumentID: frozenVersionID,
		second.ID:        second.CurrentVersion.ID,
	}
	if request.RefreshID != accepted.RefreshID || len(request.Changes.Added) != len(want) {
		t.Fatalf("candidate request did not preserve frozen Versions: %+v", request)
	}
	for _, source := range request.Changes.Added {
		if want[source.DocumentID] != source.DocumentVersionID ||
			(source.DocumentID == sourceDocumentID && string(source.Content) != "frozen Wiki source") {
			t.Fatalf("unexpected frozen source=%+v want=%v", source, want)
		}
	}

	close(generator.release)
	released = true
	// The published sources record the frozen Version, not the replacement.
	deadline := time.Now().Add(5 * time.Second)
	var refreshStatus, frozenInDatabase, currentVersionID string
	for time.Now().Before(deadline) {
		err := env.pool.QueryRow(t.Context(), `SELECT refresh.status,coalesce(source.document_version_id,''),
			document.current_version_id
			FROM document_wiki_refreshes refresh
			JOIN documents document ON document.id=$2
			LEFT JOIN document_wiki_published_sources source
			  ON source.wiki_id=refresh.wiki_id AND source.document_id=document.id
			 AND refresh.status='settled'
			WHERE refresh.id=$1`, accepted.RefreshID, sourceDocumentID).Scan(
			&refreshStatus, &frozenInDatabase, &currentVersionID,
		)
		if err != nil {
			t.Fatal(err)
		}
		if refreshStatus == "settled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if refreshStatus != "settled" || frozenInDatabase != frozenVersionID || currentVersionID != replacement.ID {
		t.Fatalf("refresh=%s frozen=%s want=%s current=%s want=%s",
			refreshStatus, frozenInDatabase, frozenVersionID, currentVersionID, replacement.ID)
	}
	// The replacement waits for the next nightly refresh: settlement queues
	// no follow-up for a source that changed while the refresh ran.
	if got := countRows(t, env, `SELECT count(*) FROM river_job
		WHERE kind='document.wiki_refresh_followup' AND args->>'refresh_id'=$1`, accepted.RefreshID); got != 0 {
		t.Fatalf("settlement queued %d follow-ups", got)
	}
}
