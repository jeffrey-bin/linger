package integration_test

import (
	"bytes"
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestPersonalWikiInputTreeAndImmutableVersions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	firstContent := []byte("first immutable Wiki source")
	uploaded := uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-version-first-"+suffix,
		"source.txt", "plain_text", "text/plain", firstContent)
	status, _, body := requestUnifiedDocumentVersionUpload(t, env, alice, uploaded.ID,
		"wiki-version-second-"+suffix, map[string]string{
			"expected_current_version_id": uploaded.CurrentVersion.ID,
			"filename":                    "source-v2.txt",
			"representation_format":       "plain_text",
			"media_type":                  "text/plain",
		}, "source-v2.txt", []byte("second immutable Wiki source"))
	var replacement struct {
		ID            string `json:"id"`
		VersionNumber int    `json:"version_number"`
	}
	decode(t, body, &replacement)
	if status != http.StatusCreated || replacement.ID == "" || replacement.VersionNumber != 2 {
		t.Fatalf("replacement status=%d value=%+v body=%s", status, replacement, body)
	}
	assertUnifiedWikiVersionContent(t, env, alice, uploaded, firstContent, "text/plain")
	status, _, body = requestUnifiedDocumentVersionContent(t, env, alice, http.MethodGet,
		"/v0/document-versions/"+replacement.ID+"/content", nil)
	if status != http.StatusOK || string(body) != "second immutable Wiki source" {
		t.Fatalf("replacement content status=%d body=%q", status, body)
	}
	if _, err := env.pool.Exec(context.Background(), `UPDATE document_versions
		SET filename='mutated.txt' WHERE id=$1`, replacement.ID); err == nil {
		t.Fatal("immutable Document Version accepted mutation")
	}
	var currentVersionID string
	if err := env.pool.QueryRow(context.Background(), `SELECT current_version_id
		FROM documents WHERE id=$1`, uploaded.ID).Scan(&currentVersionID); err != nil {
		t.Fatal(err)
	}
	if currentVersionID != replacement.ID {
		t.Fatalf("current Version=%s want=%s", currentVersionID, replacement.ID)
	}
}

func TestPersonalWikiInputQuotaReplayAndImmutability(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("ensure Wiki status=%d body=%s", status, body)
	}
	key := "wiki-upload-replay-" + suffix
	fields := map[string]string{
		"filename": "replay.txt", "representation_format": "plain_text", "media_type": "text/plain",
	}
	status, headers, firstBody := requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/uploads", key, fields,
		"replay.txt", []byte("exact replay bytes"))
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "" {
		t.Fatalf("first upload status=%d replay=%q body=%s", status, headers.Get("Idempotent-Replay"), firstBody)
	}
	status, headers, replayBody := requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/uploads", key, fields,
		"replay.txt", []byte("exact replay bytes"))
	if status != http.StatusCreated || headers.Get("Idempotent-Replay") != "true" ||
		!bytes.Equal(firstBody, replayBody) {
		t.Fatalf("upload replay status=%d replay=%q equal=%t body=%s", status,
			headers.Get("Idempotent-Replay"), bytes.Equal(firstBody, replayBody), replayBody)
	}
	status, _, body = requestUnifiedDocumentMultipart(t, env, alice,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/uploads",
		"wiki-upload-too-large-"+suffix, map[string]string{
			"filename": "too-large.bin", "representation_format": "binary",
			"media_type": "application/octet-stream",
		}, "too-large.bin", make([]byte, (1<<20)+1))
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload status=%d body=%s", status, body)
	}
	var uploaded unifiedWikiSourceUpload
	decode(t, firstBody, &uploaded)
	if got := countRows(t, env, `SELECT count(*) FROM document_versions WHERE document_id=$1`, uploaded.ID); got != 1 {
		t.Fatalf("replayed upload Version rows=%d want=1", got)
	}
}

func TestPersonalWikiMarkdownSourceUploadAdmitsRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &blockingUnifiedWikiGenerator{
		started: make(chan document.WikiCandidateGenerationRequest, 1),
		release: make(chan struct{}),
	}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	// Registered after the app so it runs before Close; a blocked generation
	// would otherwise hold Close for the whole River stop budget.
	t.Cleanup(func() { close(generator.release) })
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	content := []byte("# Markdown Wiki source\n")
	wikiID, sourceID, versionID := seedUnifiedWikiPublicAdmissionSource(t, env, alice, suffix, true,
		"notes.md", "markdown", "text/markdown", content)
	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.Status != "accepted" ||
		accepted.WikiID != wikiID || accepted.RefreshID == "" {
		t.Fatalf("markdown refresh admission status=%d body=%s", status, body)
	}
	var request document.WikiCandidateGenerationRequest
	select {
	case request = <-generator.started:
	case <-time.After(5 * time.Second):
		t.Fatal("candidate generator did not receive markdown refresh")
	}
	if len(request.Changes.Added) != 1 || request.Changes.Added[0].DocumentID != sourceID ||
		request.Changes.Added[0].DocumentVersionID != versionID ||
		!bytes.Equal(request.Changes.Added[0].Content, content) {
		t.Fatalf("frozen markdown source=%+v", request.Changes.Added)
	}
}

func TestPersonalWikiRefreshRequestState(t *testing.T) {
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
	wikiID, _, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	if wiki := readPersonalWikiHTTPStatus(t, env, alice); wiki.State != "idle" || wiki.CurrentRevisionId != nil {
		t.Fatalf("Wiki without a refresh=%+v", wiki)
	}
	// Each request names another night, so it is evaluated again.
	status, accepted, requestBody := requestNightlyWikiRefresh(t, env, "2026-11-01")
	if status != http.StatusAccepted ||
		accepted.Status != "accepted" || accepted.WikiID != wikiID || accepted.RefreshID == "" {
		t.Fatalf("refresh admission status=%d body=%s", status, requestBody)
	}
	select {
	case <-generator.started:
	case <-time.After(5 * time.Second):
		t.Fatal("candidate generator did not receive refresh")
	}
	if wiki := readPersonalWikiHTTPStatus(t, env, alice); wiki.State != "refreshing" {
		t.Fatalf("Wiki while generating=%+v", wiki)
	}
	progressStatus, progress, progressBody := requestNightlyWikiRefresh(t, env, "2026-11-02")
	if progressStatus != http.StatusAccepted || progress.Status != "in_progress" ||
		progress.RefreshID != accepted.RefreshID {
		t.Fatalf("in-progress status=%d body=%s", progressStatus, progressBody)
	}
	close(generator.release)
	released = true
	wikiRevisionID := waitForUnifiedWikiRefreshSettlement(t, env, accepted.RefreshID)
	latestStatus, latest, latestBody := requestNightlyWikiRefresh(t, env, "2026-11-03")
	if latestStatus != http.StatusOK || latest.Status != "already_latest" || latest.WikiID != wikiID {
		t.Fatalf("already-latest status=%d body=%s", latestStatus, latestBody)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id=$1`, wikiID); got != 1 {
		t.Fatalf("canonical refresh rows=%d want=1", got)
	}
	published := readPersonalWikiHTTPStatus(t, env, alice)
	// Publication commits before River finishes the follow-up. Wait for the
	// same public state the client observes; keep checking the exact revision.
	idleDeadline := time.Now().Add(10 * time.Second)
	for published.State == "refreshing" && time.Now().Before(idleDeadline) {
		time.Sleep(20 * time.Millisecond)
		published = readPersonalWikiHTTPStatus(t, env, alice)
	}
	if published.State != "idle" || published.CurrentRevisionId == nil || *published.CurrentRevisionId != wikiRevisionID {
		t.Fatalf("published Wiki=%+v", published)
	}
	// A terminal failure after publication must be visible through the same
	// endpoint Web polls, while retaining the safe Revision.
	uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-status-new-source-"+suffix,
		"new-source.txt", "plain_text", "text/plain", []byte("new source"))
	generator.fail = document.ErrWikiCandidateTerminal
	status, failing, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || failing.RefreshID == "" {
		t.Fatalf("failed refresh admission status=%d body=%s", status, body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		wiki := readPersonalWikiHTTPStatus(t, env, alice)
		if wiki.State == "failed" {
			if wiki.CurrentRevisionId == nil || *wiki.CurrentRevisionId != wikiRevisionID ||
				wiki.PublishedGeneration != published.PublishedGeneration ||
				wiki.LatestRefreshId == nil || *wiki.LatestRefreshId != failing.RefreshID {
				t.Fatalf("terminal failure changed safe publication: before=%+v after=%+v", published, wiki)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal failure not visible through HTTP: %+v", wiki)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A settled refresh leaves only itself; admission keeps the latest finished
// refresh beside the new one.
func TestPersonalWikiKeepsCurrentRevisionAndLatestRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	wikiID, _, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	refresh := func(step, date string) string {
		status, accepted, body := requestNightlyWikiRefresh(t, env, date)
		if status != http.StatusAccepted || accepted.RefreshID == "" {
			t.Fatalf("%s refresh status=%d body=%s", step, status, body)
		}
		return accepted.RefreshID
	}
	addSource := func(step string) {
		uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-retention-source-"+step+"-"+suffix,
			step+".txt", "plain_text", "text/plain", []byte(step))
	}
	assertRetained := func(step string, refreshIDs []string, revisionID string) {
		t.Helper()
		var refreshes []string
		var currentRevisionID string
		if err := env.pool.QueryRow(t.Context(), `SELECT
			ARRAY(SELECT id FROM document_wiki_refreshes WHERE wiki_id=$1 ORDER BY created_at,id),
			(SELECT coalesce(current_revision_id,'') FROM personal_wikis WHERE id=$1)`,
			wikiID).Scan(&refreshes, &currentRevisionID); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(refreshes, refreshIDs) || currentRevisionID != revisionID {
			t.Fatalf("%s: refreshes=%v want=%v current=%s want=%s",
				step, refreshes, refreshIDs, currentRevisionID, revisionID)
		}
	}

	first := refresh("first", "2026-11-01")
	firstRevision := waitForUnifiedWikiRefreshSettlement(t, env, first)
	assertRetained("first settlement", []string{first}, firstRevision)

	addSource("second")
	second := refresh("second", "2026-11-02")
	secondRevision := waitForUnifiedWikiRefreshSettlement(t, env, second)
	assertRetained("second settlement", []string{second}, secondRevision)

	addSource("third")
	generator.mu.Lock()
	generator.fail = document.ErrWikiCandidateTerminal
	generator.mu.Unlock()
	third := refresh("third", "2026-11-03")
	deadline := time.Now().Add(30 * time.Second)
	for {
		var status string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM document_wiki_refreshes
			WHERE id=$1`, third).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("third refresh status=%s", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	assertRetained("failure", []string{second, third}, secondRevision)

	addSource("fourth")
	release := make(chan struct{})
	generator.mu.Lock()
	generator.fail = nil
	generator.beforeReturn = func(ctx context.Context, _ document.WikiCandidateGenerationRequest) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	generator.mu.Unlock()
	fourth := refresh("fourth", "2026-11-04")
	assertRetained("admission", []string{third, fourth}, secondRevision)
	close(release)
	fourthRevision := waitForUnifiedWikiRefreshSettlement(t, env, fourth)
	assertRetained("fourth settlement", []string{fourth}, fourthRevision)
}

func TestPersonalWikiMarkdownRevisionPublishesAtomically(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{
			{PageKey: "index.md", Markdown: []byte("# Index\n")},
			{PageKey: "guides/start.md", Markdown: []byte("# Start\n")},
		},
	}}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	wikiID, sourceDocumentID, sourceVersionID := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.RefreshID == "" {
		t.Fatalf("refresh status=%d body=%s", status, body)
	}
	wikiRevisionID := waitForUnifiedWikiRefreshSettlement(t, env, accepted.RefreshID)
	var currentRevisionID string
	var sourceCount, pageCount int
	if err := env.pool.QueryRow(context.Background(), `SELECT wiki.current_revision_id,
		(SELECT count(*) FROM document_wiki_published_sources source
		 WHERE source.wiki_id=$1 AND source.document_id=$2 AND source.document_version_id=$3),
		(SELECT count(*) FROM document_wiki_pages page
		 JOIN documents document ON document.id=page.document_id
		 JOIN document_versions version ON version.id=document.current_version_id
		 WHERE page.wiki_id=$1 AND version.source='wiki_page')
		FROM personal_wikis wiki WHERE wiki.id=$1`, wikiID,
		sourceDocumentID, sourceVersionID).Scan(
		&currentRevisionID, &sourceCount, &pageCount,
	); err != nil {
		t.Fatal(err)
	}
	if currentRevisionID != wikiRevisionID || sourceCount != 1 || pageCount != 2 {
		t.Fatalf("settlement current=%s want=%s sources=%d pages=%d",
			currentRevisionID, wikiRevisionID, sourceCount, pageCount)
	}
	if calls := generator.callsSnapshot(); len(calls) != 1 || len(calls[0].Changes.Added) != 1 ||
		calls[0].Changes.Added[0].DocumentID != sourceDocumentID ||
		calls[0].Changes.Added[0].DocumentVersionID != sourceVersionID {
		t.Fatalf("candidate calls=%+v", calls)
	}
}

func waitForUnifiedWikiRefreshSettlement(t *testing.T, env *testEnv, refreshID string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var status, wikiRevisionID string
	for time.Now().Before(deadline) {
		if err := env.pool.QueryRow(t.Context(), `SELECT status,coalesce(result_wiki_revision_id,'')
			FROM document_wiki_refreshes WHERE id=$1`, refreshID).Scan(&status, &wikiRevisionID); err != nil {
			t.Fatal(err)
		}
		if status == "settled" {
			return wikiRevisionID
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Wiki refresh=%s status=%s revision=%s", refreshID, status, wikiRevisionID)
	return ""
}

// Concurrent uploads into one Personal Wiki touch the same rows under
// serializable isolation. A serialization failure must be retried instead of
// failing the upload with a 500.
func TestConcurrentPersonalWikiUploadsAllSucceed(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("ensure Wiki status=%d body=%s", status, body)
	}
	const uploads = 8
	statuses := make([]int, uploads)
	bodies := make([][]byte, uploads)
	var wait sync.WaitGroup
	for index := range uploads {
		wait.Add(1)
		go func() {
			defer wait.Done()
			name := "concurrent-" + strconv.Itoa(index) + ".txt"
			statuses[index], _, bodies[index] = requestUnifiedDocumentMultipart(t, env, alice,
				"/v0/tenants/"+acmeTenant+"/personal-wiki/documents/uploads",
				"wiki-concurrent-"+strconv.Itoa(index)+"-"+suffix, map[string]string{
					"filename": name, "representation_format": "plain_text", "media_type": "text/plain",
				}, name, []byte("concurrent source "+strconv.Itoa(index)))
		}()
	}
	wait.Wait()
	for index, status := range statuses {
		if status != http.StatusCreated {
			t.Fatalf("upload %d status=%d body=%s", index, status, bodies[index])
		}
	}
}
