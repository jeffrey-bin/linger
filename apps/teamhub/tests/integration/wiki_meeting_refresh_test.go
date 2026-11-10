package integration_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// A meeting refresh admits only that meeting's recording Session. Every other
// source keeps its published version, a changed Document's newer text
// included, so the request carries no other change, and settlement queues no
// follow-up. The nightly refresh then takes the rest.
func TestMeetingWikiRefreshAdmitsOnlyThatMeeting(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	f := newUnifiedWikiDispatchCase(t, "meeting", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}, "replaceable")
	if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, f.admission.ID); err != nil || !worked {
		t.Fatalf("initial publication worked=%v err=%v", worked, err)
	}
	newVersionID := replaceUnifiedWikiDispatchSource(t, f, "edited during the day")
	readyDocumentTexts(t, f.pool, f.objects, nil)
	if err := storeIndexedWikiSession(f.ctx, f.db, "room-chat", "A chat during the day"); err != nil {
		t.Fatal(err)
	}
	roomID := indexedWikiSourceID("room-chat")
	meetingID, meetingVersion, err := storeIndexedWikiRecording(f.ctx, f.db, "meeting-a", "capture_a", "Meeting transcript")
	if err != nil {
		t.Fatal(err)
	}

	meeting, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04", CaptureID: "capture_a",
	})
	if err != nil || meeting.Refresh.Status != document.WikiRefreshAccepted ||
		addedWikiSources(t, f.db, meeting.Refresh.ID) != 1 {
		t.Fatalf("meeting admission=%+v err=%v", meeting.Refresh, err)
	}
	frozen := frozenWikiSources(t, f.db, meeting.Refresh.ID)
	if len(frozen) != 3 || frozen["document_human_a"] != "version_wiki_dispatch_source" ||
		frozen["document_wiki_replaceable_source"] != "version_wiki_replaceable_source" ||
		frozen[meetingID] != meetingVersion || frozen[roomID] != "" {
		t.Fatalf("meeting froze %v", frozen)
	}
	var captureID string
	var deferred bool
	if err := f.db.QueryRowContext(f.ctx, `SELECT coalesce(capture_id,''),sources_deferred
		FROM document_wiki_refreshes WHERE id=$1`, meeting.Refresh.ID).Scan(&captureID, &deferred); err != nil ||
		captureID != "capture_a" || deferred {
		t.Fatalf("meeting refresh capture=%q deferred=%v err=%v", captureID, deferred, err)
	}

	if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, meeting.Refresh.ID); err != nil || !worked {
		t.Fatalf("meeting delivery worked=%v err=%v", worked, err)
	}
	calls := generator.callsSnapshot()
	request := calls[len(calls)-1]
	if request.Mode != "update" || len(request.Changes.Added) != 1 || len(request.Changes.Modified) != 0 ||
		len(request.Changes.Removed) != 0 || request.Changes.Added[0].DocumentID != meetingID ||
		request.Changes.Added[0].Session == nil || request.Changes.Added[0].Session.Kind != "recording" ||
		request.Changes.Added[0].Session.SessionID != "capture_a" {
		t.Fatalf("meeting request changes=%+v", request.Changes)
	}
	published := publishedWikiSources(t, f.db)
	if published["document_wiki_replaceable_source"] != "version_wiki_replaceable_source" ||
		published[meetingID] != meetingVersion || published[roomID] != "" {
		t.Fatalf("meeting published %v", published)
	}
	if followups := countWikiRefreshFollowups(t, f.db, meeting.Refresh.ID); followups != 0 {
		t.Fatalf("meeting settlement queued %d follow-ups", followups)
	}
	again, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04", CaptureID: "capture_a",
	})
	if err != nil || again.Refresh.Status != document.WikiRefreshAlreadyLatest {
		t.Fatalf("published meeting again=%+v err=%v", again.Refresh, err)
	}
	unknown, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04", CaptureID: "capture_unknown",
	})
	if err != nil || unknown.Refresh.Status != document.WikiRefreshNoSources {
		t.Fatalf("meeting without Sessions=%+v err=%v", unknown.Refresh, err)
	}

	nightly, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
	})
	if err != nil || nightly.Refresh.Status != document.WikiRefreshAccepted {
		t.Fatalf("nightly admission=%+v err=%v", nightly.Refresh, err)
	}
	if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, nightly.Refresh.ID); err != nil || !worked {
		t.Fatalf("nightly delivery worked=%v err=%v", worked, err)
	}
	calls = generator.callsSnapshot()
	request = calls[len(calls)-1]
	if len(request.Changes.Added) != 1 || request.Changes.Added[0].DocumentID != roomID ||
		len(request.Changes.Modified) != 1 || request.Changes.Modified[0].DocumentVersionID != newVersionID {
		t.Fatalf("nightly request changes=%+v", request.Changes)
	}
}

// While a refresh runs, a meeting request is not admitted and leaves no
// follow-up: Memory asks again once that refresh has finished. A nightly
// request marks the running refresh, whose settlement queues the follow-up.
func TestMeetingWikiRefreshWaitsForTheRunningRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	f := newUnifiedWikiDispatchCase(t, "meeting-busy", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if _, _, err := storeIndexedWikiRecording(f.ctx, f.db, "meeting-a", "capture_a", "Meeting transcript"); err != nil {
		t.Fatal(err)
	}
	followupRequested := func() bool {
		t.Helper()
		var requested bool
		if err := f.db.QueryRowContext(f.ctx, `SELECT followup_requested FROM document_wiki_refreshes WHERE id=$1`,
			f.admission.ID).Scan(&requested); err != nil {
			t.Fatal(err)
		}
		return requested
	}
	meeting, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04", CaptureID: "capture_a",
	})
	if err != nil || meeting.Refresh.Status != document.WikiRefreshInProgress || meeting.Refresh.ID != f.admission.ID ||
		followupRequested() {
		t.Fatalf("meeting during a refresh=%+v err=%v", meeting.Refresh, err)
	}
	nightly, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
	})
	if err != nil || nightly.Refresh.Status != document.WikiRefreshInProgress || !followupRequested() {
		t.Fatalf("nightly during a refresh=%+v err=%v", nightly.Refresh, err)
	}
	if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, f.admission.ID); err != nil || !worked {
		t.Fatalf("delivery worked=%v err=%v", worked, err)
	}
	if followups := countWikiRefreshFollowups(t, f.db, f.admission.ID); followups != 1 {
		t.Fatalf("settlement queued %d follow-ups, want 1", followups)
	}
	if err := drainDocumentJobs(f.ctx, f.pool, f.service, nil); err != nil {
		t.Fatal(err)
	}
	var refreshID string
	var captured bool
	if err := f.db.QueryRowContext(f.ctx, `SELECT id,capture_id IS NOT NULL FROM document_wiki_refreshes
		WHERE status='staging'`).Scan(&refreshID, &captured); err != nil || captured {
		t.Fatalf("follow-up refresh=%s meeting scope=%v err=%v", refreshID, captured, err)
	}
	meetingID := indexedWikiSourceID("meeting-a")
	if frozen := frozenWikiSources(t, f.db, refreshID); frozen[meetingID] == "" {
		t.Fatalf("the nightly follow-up left the meeting out: %v", frozen)
	}
}

// storeIndexedWikiRecording writes one recording Session the way Memory's
// index does and returns its source ID and version.
func storeIndexedWikiRecording(ctx context.Context, db *sql.DB, sessionKey, captureID, text string) (string, string, error) {
	sourceKey := sha256.Sum256([]byte(sessionKey))
	sourceID := indexedWikiSourceID(sessionKey)
	content := sha256.Sum256([]byte(text))
	digest := hex.EncodeToString(content[:])
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_index.sources(id,tenant_id,owner_id,agent_id,document_id,
			source_path,title,active_sha256,index_profile,source_kind,origin_kind,source_uri,source_version,metadata,room_id)
		SELECT $1,'tenant_document_a','actor_human_a',registration.agent_management_id,$2,
			'memory/evidence/2026-11-04/sessions/recordings/'||$4||'.md','Recording '||$4,$3,'raw-test',
			'recording_transcript','recording','teamhub://documents/document_transcript_a/versions/version_transcript_a',$3,
			jsonb_build_object('room_id','room_document_a','capture_id',$4::text),'room_document_a'
		FROM agent_registrations registration WHERE registration.actor_id='actor_agent_a'
		ON CONFLICT (id) DO UPDATE SET active_sha256=EXCLUDED.active_sha256,source_version=EXCLUDED.source_version`,
		sourceID, hex.EncodeToString(sourceKey[:]), digest, captureID); err != nil {
		return "", "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_index.source_versions(source_id,sha256,manifest,content,size_bytes)
		VALUES($1,$2,'{"date":"2026-11-04"}',$3,octet_length($3)) ON CONFLICT DO NOTHING`, sourceID, digest, text); err != nil {
		return "", "", err
	}
	return sourceID, digest, tx.Commit()
}

// indexedWikiSourceID is the Memory index source ID the store helpers give a
// Session key.
func indexedWikiSourceID(sessionKey string) string {
	sourceKey := sha256.Sum256([]byte(sessionKey))
	return "mis_" + hex.EncodeToString(sourceKey[:12])
}

func frozenWikiSources(t *testing.T, db *sql.DB, refreshID string) map[string]string {
	t.Helper()
	return wikiSourceVersions(t, db, `SELECT document_id,frozen_document_version_id
		FROM document_wiki_refresh_sources WHERE refresh_id=$1`, refreshID)
}

func publishedWikiSources(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	return wikiSourceVersions(t, db, `SELECT document_id,document_version_id
		FROM document_wiki_published_sources WHERE wiki_id='wiki_document_a'`)
}

func wikiSourceVersions(t *testing.T, db *sql.DB, query string, arguments ...any) map[string]string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), query, arguments...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	versions := map[string]string{}
	for rows.Next() {
		var documentID, versionID string
		if err := rows.Scan(&documentID, &versionID); err != nil {
			t.Fatal(err)
		}
		versions[documentID] = versionID
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return versions
}

// addedWikiSources counts the sources a refresh froze that its Wiki has not
// published yet.
func addedWikiSources(t *testing.T, db *sql.DB, refreshID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `SELECT count(*) FROM document_wiki_refresh_sources frozen
		JOIN document_wiki_refreshes refresh ON refresh.id=frozen.refresh_id
		WHERE frozen.refresh_id=$1 AND NOT EXISTS(SELECT 1 FROM document_wiki_published_sources source
		  WHERE source.wiki_id=refresh.wiki_id AND source.document_id=frozen.document_id)`, refreshID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// wikiVerdictReasons returns each bound Wiki source of the tenant that the
// whitelist keeps out, by Document, with its reason.
func wikiVerdictReasons(t *testing.T, db *sql.DB, tenantID string) map[string]string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `SELECT document_id, reason FROM wiki_document_verdicts
		WHERE tenant_id=$1 AND reason IS NOT NULL`, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	reasons := map[string]string{}
	for rows.Next() {
		var id, reason string
		if err := rows.Scan(&id, &reason); err != nil {
			t.Fatal(err)
		}
		reasons[id] = reason
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return reasons
}

func countWikiRefreshFollowups(t *testing.T, db *sql.DB, refreshID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `SELECT count(*) FROM river_job
		WHERE kind='document.wiki_refresh_followup' AND args->>'refresh_id'=$1`, refreshID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
