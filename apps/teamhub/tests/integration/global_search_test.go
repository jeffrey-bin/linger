package integration_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/documenttext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type messageSearchPage struct {
	Items []struct {
		Message struct {
			ID         string `json:"id"`
			RawMessage string `json:"raw_message"`
			RoomID     string `json:"room_id"`
		} `json:"message"`
		Room struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Kind string `json:"kind"`
		} `json:"room"`
	} `json:"items"`
	Page struct {
		HasMore    bool    `json:"has_more"`
		NextCursor *string `json:"next_cursor"`
	} `json:"page"`
}

func searchMessages(t *testing.T, env *testEnv, client *http.Client, tenantID string, query url.Values) (int, messageSearchPage) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet,
		"/v0/tenants/"+tenantID+"/messages/search?"+query.Encode(), nil, "")
	var page messageSearchPage
	if status == http.StatusOK {
		decode(t, body, &page)
	}
	return status, page
}

func messageBodies(page messageSearchPage) map[string]bool {
	bodies := make(map[string]bool, len(page.Items))
	for _, item := range page.Items {
		bodies[item.Message.RawMessage] = true
	}
	return bodies
}

// TestGlobalSearchMessagesPublicHTTP proves keyword Message search follows Room
// visibility: members see hits, non-members and other Tenants do not, leaving a
// Room freezes what the leaver can find, and the cursor pages newest first.
func TestGlobalSearchMessagesPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	sharedRoom := env.createRoom(alice, acmeTenant, "search-shared-"+suffix, "search-shared-"+suffix)
	privateRoom := env.createRoom(alice, acmeTenant, "search-private-"+suffix, "search-private-"+suffix)
	if status, body := putRoomMember(t, env, alice, sharedRoom, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	env.createMessage(alice, sharedRoom, "Kraken deploy plan for Friday", "search-msg-1-"+suffix)
	seedAgentMessage(t, env, sharedRoom, "actor_acme_official", "kraken retro notes")
	env.createMessage(alice, privateRoom, "kraken secret budget", "search-msg-3-"+suffix)
	env.createMessage(alice, sharedRoom, "unrelated lunch order", "search-msg-4-"+suffix)

	status, page := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"kraken"}})
	if status != http.StatusOK || len(page.Items) != 3 || page.Page.HasMore {
		t.Fatalf("alice search status=%d items=%d has_more=%v", status, len(page.Items), page.Page.HasMore)
	}
	for _, item := range page.Items {
		if item.Room.Kind != "room" || item.Room.ID != item.Message.RoomID {
			t.Fatalf("hit room = %+v for message %+v", item.Room, item.Message)
		}
	}
	status, page = searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"KRAKEN"}})
	if status != http.StatusOK || len(page.Items) != 3 {
		t.Fatalf("case-insensitive search status=%d items=%+v", status, page.Items)
	}
	if status, _ := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"   "}}); status != http.StatusBadRequest {
		t.Fatalf("blank query status=%d, want 400", status)
	}

	status, firstPage := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"kraken"}, "limit": {"2"}})
	if status != http.StatusOK || len(firstPage.Items) != 2 || !firstPage.Page.HasMore || firstPage.Page.NextCursor == nil {
		t.Fatalf("first page status=%d items=%d page=%+v", status, len(firstPage.Items), firstPage.Page)
	}
	status, secondPage := searchMessages(t, env, alice, acmeTenant,
		url.Values{"q": {"kraken"}, "limit": {"2"}, "cursor": {*firstPage.Page.NextCursor}})
	if status != http.StatusOK || len(secondPage.Items) != 1 || secondPage.Page.HasMore {
		t.Fatalf("second page status=%d items=%d page=%+v", status, len(secondPage.Items), secondPage.Page)
	}
	seen := messageBodies(firstPage)
	if seen[secondPage.Items[0].Message.RawMessage] || len(seen) != 2 {
		t.Fatalf("pages overlap: first=%v second=%q", seen, secondPage.Items[0].Message.RawMessage)
	}

	// Leaving freezes the Human's view: earlier hits stay, later Messages never appear.
	if status, _, body := env.request(alice, http.MethodPut, "/v0/rooms/"+sharedRoom+"/participation",
		map[string]any{"status": "left"}, "search-leave-"+suffix); status != http.StatusOK {
		t.Fatalf("leave status=%d body=%s", status, body)
	}
	seedAgentMessage(t, env, sharedRoom, "actor_acme_official", "kraken postmortem after the Human left")
	status, page = searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"kraken"}})
	if status != http.StatusOK || len(page.Items) != 3 || messageBodies(page)["kraken postmortem after the Human left"] {
		t.Fatalf("left member search status=%d items=%+v", status, page.Items)
	}
}

// TestGlobalSearchFreezesRoomsAndThreadsAfterLeaving checks the leave freeze
// in each Room's own sequence: after the Human leaves, newer Room and Thread Messages
// are neither searchable nor readable one by one, while earlier ones stay.
func TestGlobalSearchFreezesRoomsAndThreadsAfterLeaving(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	roomID := env.createRoom(alice, acmeTenant, "search-freeze-"+suffix, "search-freeze-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	messageID := func(roomID, body string) string {
		t.Helper()
		var id string
		if err := env.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE room_id=$1 AND body=$2`, roomID, body).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	env.createMessage(alice, roomID, "walrus root "+suffix, "search-freeze-root-"+suffix)
	status, _, body := env.request(alice, http.MethodPost,
		"/v0/rooms/"+roomID+"/messages/"+messageID(roomID, "walrus root "+suffix)+"/thread", map[string]any{}, "search-freeze-thread-"+suffix)
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("create Thread status=%d body=%s", status, body)
	}
	var thread struct {
		Room struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	decode(t, body, &thread)
	env.createMessage(alice, thread.Room.ID, "walrus thread before "+suffix, "search-freeze-thread-before-"+suffix)
	// The parent Room's sequence runs ahead of the Thread's, so comparing
	// Thread Messages with the parent's frozen position would admit later ones.
	for index := range 3 {
		env.createMessage(alice, roomID, fmt.Sprintf("padding %d %s", index, suffix), fmt.Sprintf("search-freeze-padding-%d-%s", index, suffix))
	}
	if status, _, body := env.request(alice, http.MethodPut, "/v0/rooms/"+roomID+"/participation",
		map[string]any{"status": "left"}, "search-freeze-leave-"+suffix); status != http.StatusOK {
		t.Fatalf("leave status=%d body=%s", status, body)
	}
	seedAgentMessage(t, env, thread.Room.ID, "actor_acme_official", "walrus thread after "+suffix)
	seedAgentMessage(t, env, roomID, "actor_acme_official", "walrus room after "+suffix)

	status, page := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {"walrus"}})
	bodies := messageBodies(page)
	if status != http.StatusOK || len(page.Items) != 2 || !bodies["walrus root "+suffix] || !bodies["walrus thread before "+suffix] {
		t.Fatalf("left member search status=%d items=%+v", status, page.Items)
	}
	for _, read := range []struct {
		roomID, body string
		want         int
	}{
		{roomID, "walrus root " + suffix, http.StatusOK},
		{thread.Room.ID, "walrus thread before " + suffix, http.StatusOK},
		{thread.Room.ID, "walrus thread after " + suffix, http.StatusNotFound},
		{roomID, "walrus room after " + suffix, http.StatusNotFound},
	} {
		status, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+read.roomID+"/messages/"+messageID(read.roomID, read.body), nil, "")
		if status != read.want {
			t.Fatalf("read %q status=%d want %d body=%s", read.body, status, read.want, body)
		}
	}
}

// TestGlobalSearchCountsQueryCharacters checks that the 200-character query
// limit counts characters: 70 euro signs are 210 bytes.
func TestGlobalSearchCountsQueryCharacters(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	query := strings.Repeat("€", 70)
	if status, page := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {query}}); status != http.StatusOK || len(page.Items) != 0 {
		t.Fatalf("Message search status=%d items=%d", status, len(page.Items))
	}
	if page := searchDocuments(t, env, alice, url.Values{"q": {query}}); len(page.Items) != 0 {
		t.Fatalf("Document search items=%d", len(page.Items))
	}
	if status, _ := searchMessages(t, env, alice, acmeTenant, url.Values{"q": {strings.Repeat("€", 201)}}); status != http.StatusBadRequest {
		t.Fatalf("201-character query status=%d want 400", status)
	}
}

type documentSearchPage struct {
	Items []struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		SearchMatch *struct {
			BodyIndexStatus string  `json:"body_index_status"`
			BodySnippet     *string `json:"body_snippet"`
		} `json:"search_match"`
	} `json:"items"`
}

func searchDocuments(t *testing.T, env *testEnv, client *http.Client, query url.Values) documentSearchPage {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/library/documents/search?"+query.Encode(), nil, "")
	if status != http.StatusOK {
		t.Fatalf("document search status=%d body=%s", status, body)
	}
	var page documentSearchPage
	decode(t, body, &page)
	return page
}

func uploadSearchDocument(t *testing.T, env *testEnv, client *http.Client, key, filename string) string {
	t.Helper()
	status, _, body := requestUnifiedDocumentUpload(t, env, client, key, map[string]string{
		"filename": filename, "representation_format": "plain_text", "media_type": "text/plain",
	}, filename, []byte("immutable Version bytes for "+filename))
	if status != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	return created.ID
}

// TestGlobalSearchDocumentBodyStateMachine proves the document_texts rules on
// PostgreSQL: an upload queues one text sync, a completed sync is matched by
// keyword with a snippet, a Document without a text reports pending, and a new
// Version queues its own sync.
// unspacedKanaQuery is a substring of an unspaced katakana run in the indexed
// body, so the match cannot rely on word boundaries.
const unspacedKanaQuery = "ロールバック"

func TestGlobalSearchDocumentBodyStateMachine(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newSearchTextEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	filename := "kraken-runbook-" + suffix + ".txt"
	indexedID := uploadSearchDocument(t, env, alice, "search-body-indexed-"+suffix, filename)
	pendingID := uploadSearchDocument(t, env, alice, "search-body-pending-"+suffix, "kraken-agenda-"+suffix+".txt")
	if got := documentTextSyncJobCount(t, env, indexedID); got != 1 {
		t.Fatalf("an upload must queue one text sync, jobs=%d", got)
	}
	if _, err := env.pool.Exec(ctx, `SELECT enqueue_document_text_sync($1)`, indexedID); err != nil {
		t.Fatal(err)
	}
	if got := documentTextSyncJobCount(t, env, indexedID); got != 1 {
		t.Fatalf("a second request duplicated the queued sync: jobs=%d", got)
	}

	bodyText := "Kraken migration steps: downtime window 22:00 to 23:30，ロールバックスクリプト in the ops repo。"
	worker := newSearchTextFixtureWorker(env, searchTextFixtureNormalizer{markdown: bodyText})
	if err := worker.Work(ctx, queuedDocumentTextSyncJob(t, env, indexedID, 1)); err != nil {
		t.Fatalf("sync indexed Document: %v", err)
	}
	finishDocumentTextSyncJobs(t, env, indexedID)
	page := searchDocuments(t, env, alice, url.Values{"q": {unspacedKanaQuery}, "tenant_id": {acmeTenant}})
	if len(page.Items) != 1 || page.Items[0].ID != indexedID || page.Items[0].SearchMatch == nil ||
		page.Items[0].SearchMatch.BodyIndexStatus != "ready" || page.Items[0].SearchMatch.BodySnippet == nil ||
		*page.Items[0].SearchMatch.BodySnippet != bodyText {
		t.Fatalf("body search items=%+v", page.Items)
	}
	var markdown, markdownSHA string
	if err := env.pool.QueryRow(ctx, `select markdown,markdown_sha256 from document_texts where document_id=$1`, indexedID).Scan(&markdown, &markdownSHA); err != nil {
		t.Fatal(err)
	}
	if markdown != bodyText || len(markdownSHA) != 64 {
		t.Fatalf("stored markdown=%q sha=%q", markdown, markdownSHA)
	}
	page = searchDocuments(t, env, alice, url.Values{"q": {"kraken-agenda-" + suffix}, "tenant_id": {acmeTenant}})
	if len(page.Items) != 1 || page.Items[0].ID != pendingID || page.Items[0].SearchMatch == nil ||
		page.Items[0].SearchMatch.BodyIndexStatus != "pending" || page.Items[0].SearchMatch.BodySnippet != nil {
		t.Fatalf("pending Document search items=%+v", page.Items)
	}
	if got := documentTextSyncJobCount(t, env, indexedID); got != 0 {
		t.Fatalf("a synced Document must not be queued again, jobs=%d", got)
	}

	// A new Version queues its own sync, which replaces the text.
	var currentVersionID string
	if err := env.pool.QueryRow(ctx, `select current_version_id from documents where id=$1`, indexedID).Scan(&currentVersionID); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentVersionUpload(t, env, alice, indexedID, "search-body-indexed-v2-"+suffix,
		map[string]string{
			"expected_current_version_id": currentVersionID,
			"filename":                    filename, "representation_format": "plain_text", "media_type": "text/plain",
		}, filename, []byte("second Version bytes"))
	if status != http.StatusCreated {
		t.Fatalf("upload second Version status=%d body=%s", status, body)
	}
	if got := documentTextSyncJobCount(t, env, indexedID); got != 1 {
		t.Fatalf("a new Version must queue one text sync, jobs=%d", got)
	}
	second := newSearchTextFixtureWorker(env, searchTextFixtureNormalizer{markdown: "Second Version body"})
	if err := second.Work(ctx, queuedDocumentTextSyncJob(t, env, indexedID, 1)); err != nil {
		t.Fatalf("sync the new Version: %v", err)
	}
	if err := env.pool.QueryRow(ctx, `select current_version_id from documents where id=$1`, indexedID).Scan(&currentVersionID); err != nil {
		t.Fatal(err)
	}
	if status, sourceID := documentTextRow(t, env, indexedID); status != "ready" || sourceID != currentVersionID {
		t.Fatalf("status=%q source=%q, want ready for %q", status, sourceID, currentVersionID)
	}
}

// TestGlobalSearchDocumentSnippetMarksOnlyCutText proves a body snippet keeps
// about 60 characters on each side of the first match and marks with … only
// a side where it cut text: a match near the start of a short body returns the
// whole body.
func TestGlobalSearchDocumentSnippetMarksOnlyCutText(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	_, pool := newUnifiedDocumentFixture(t, `
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
		) VALUES('document_snippet_long','tenant_document_a','Long notes','txt',
			'actor_human_a','human','actor_human_a','human','active');
	`)
	shortBody := "kraken " + strings.Repeat("a", 100)
	longBody := strings.Repeat("b", 100) + " kraken " + strings.Repeat("c", 200)
	if _, err := pool.Exec(ctx, `INSERT INTO document_texts(
		document_id,tenant_id,source_kind,source_id,status,markdown,markdown_sha256,search_text
	) VALUES('document_human_a','tenant_document_a','native_body','1','ready',$1,repeat('a',64),$1),
		('document_snippet_long','tenant_document_a','file_version','version_snippet_long','ready',$2,repeat('b',64),$2)
	ON CONFLICT (document_id) DO UPDATE SET source_kind=EXCLUDED.source_kind,source_id=EXCLUDED.source_id,
		status=EXCLUDED.status,markdown=EXCLUDED.markdown,markdown_sha256=EXCLUDED.markdown_sha256,
		search_text=EXCLUDED.search_text`,
		shortBody, longBody); err != nil {
		t.Fatal(err)
	}
	page, err := document.New(pool).Search(ctx, document.SearchInput{
		AccountID: "account_document_a", Query: "KRAKEN", Limit: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	snippets := map[string]string{}
	for _, item := range page.Items {
		if item.SearchMatch == nil || item.SearchMatch.BodyIndexStatus != "ready" {
			t.Fatalf("Document %s search match=%+v", item.ID, item.SearchMatch)
		}
		snippets[item.ID] = item.SearchMatch.BodySnippet
	}
	wantLong := "…" + strings.Repeat("b", 59) + " kraken " + strings.Repeat("c", 59) + "…"
	if len(snippets) != 2 || snippets["document_human_a"] != shortBody || snippets["document_snippet_long"] != wantLong {
		t.Fatalf("snippets=%q", snippets)
	}
}

// TestDocumentTextSyncSendsFilenameForGenericMediaType uploads a .ts file
// without a media type through the API and syncs it with the real Version
// store: the normalizer receives the filename and representation format that
// pick a code extractor for application/octet-stream, and the body becomes
// searchable. A normalization timeout is then recorded as failed without a
// River retry, because the same bytes would time out again.
func TestDocumentTextSyncSendsFilenameForGenericMediaType(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newSearchTextEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	filename := "Déploiement rollout-" + suffix + ".ts"
	status, _, body := requestUnifiedDocumentUpload(t, env, alice, "search-body-generic-"+suffix, map[string]string{
		"filename": filename, "representation_format": "ts",
	}, filename, []byte("export const rollout = 'kraken-"+suffix+"';\n"))
	if status != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	objects, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var received documenttext.NormalizationSource
	normalizer := searchTextRecordingNormalizer{received: &received, markdown: "export const rollout = 'kraken-" + suffix + "';"}
	worker := documenttext.NewWorker(store.New(env.pool), document.NewWithObjectStore(env.pool, objects), objects, normalizer, nil)
	if err := worker.Work(ctx, queuedDocumentTextSyncJob(t, env, created.ID, 1)); err != nil {
		t.Fatalf("sync generic upload: %v", err)
	}
	if received.MediaType != "application/octet-stream" || received.Filename != filename ||
		received.RepresentationFormat != "ts" || !strings.Contains(string(received.Bytes), "kraken-"+suffix) {
		t.Fatalf("normalizer received %+v", received)
	}
	finishDocumentTextSyncJobs(t, env, created.ID)
	page := searchDocuments(t, env, alice, url.Values{"q": {"kraken-" + suffix}, "tenant_id": {acmeTenant}})
	if len(page.Items) != 1 || page.Items[0].ID != created.ID || page.Items[0].SearchMatch == nil ||
		page.Items[0].SearchMatch.BodyIndexStatus != "ready" || page.Items[0].SearchMatch.BodySnippet == nil {
		t.Fatalf("generic upload body search items=%+v", page.Items)
	}
	// The Version is immutable, so a later sync of its ready text does nothing.
	received = documenttext.NormalizationSource{}
	if err := worker.Work(ctx, &river.Job[documenttext.SyncArgs]{JobRow: &rivertype.JobRow{Attempt: 1}, Args: documenttext.SyncArgs{DocumentID: created.ID}}); err != nil || received.Filename != "" {
		t.Fatalf("ready Version synced again: received=%+v err=%v", received, err)
	}

	// A timeout from the normalization contract fails the source on the first
	// attempt and returns nothing for River to retry. A ready Version is never
	// synced again, so the timeout meets a new upload.
	timedOutID := uploadSearchDocument(t, env, alice, "search-body-timeout-"+suffix, "timeout-"+suffix+".txt")
	timedOut := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = writer.Write([]byte(`{"error":{"code":"DOCUMENT_NORMALIZATION_TIMEOUT","disposition":"terminal"}}`))
	}))
	defer timedOut.Close()
	client, err := documenttext.NewNormalizerClient(timedOut.URL, "token", timedOut.Client())
	if err != nil {
		t.Fatal(err)
	}
	worker = documenttext.NewWorker(store.New(env.pool), document.NewWithObjectStore(env.pool, objects), objects, client, nil)
	if err := worker.Work(ctx, &river.Job[documenttext.SyncArgs]{JobRow: &rivertype.JobRow{Attempt: 1}, Args: documenttext.SyncArgs{DocumentID: timedOutID}}); err != nil {
		t.Fatalf("a normalization timeout must not be retried, got %v", err)
	}
	if status, _ := documentTextRow(t, env, timedOutID); status != documenttext.StatusFailed {
		t.Fatalf("timed-out source status=%q, want failed", status)
	}
}

// TestDocumentTextSyncSendsSafeFilename uploads a file whose name has a tab.
// The normalization route rejects control characters in X-Source-Filename, so
// the client sends a safe name and the body still becomes searchable.
func TestDocumentTextSyncSendsSafeFilename(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newSearchTextEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	filename := "Größe\tplan-" + suffix + ".txt"
	status, _, body := requestUnifiedDocumentUpload(t, env, alice, "search-body-tab-"+suffix, map[string]string{
		"filename": filename, "representation_format": "plain_text", "media_type": "text/plain",
	}, "plan.txt", []byte("tabbed narwhal-"+suffix+"\n"))
	if status != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	var sentFilename string
	normalizer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		decoded, err := url.PathUnescape(request.Header.Get("X-Source-Filename"))
		if err != nil || strings.ContainsFunc(decoded, func(character rune) bool { return character <= 0x1f || character == 0x7f }) {
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = writer.Write([]byte(`{"error":{"code":"DOCUMENT_NORMALIZATION_INVALID","disposition":"terminal"}}`))
			return
		}
		sentFilename = decoded
		source, _ := io.ReadAll(request.Body)
		_, _ = writer.Write(source)
	}))
	defer normalizer.Close()
	client, err := documenttext.NewNormalizerClient(normalizer.URL, "token", normalizer.Client())
	if err != nil {
		t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(env.artifactRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	worker := documenttext.NewWorker(store.New(env.pool), document.NewWithObjectStore(env.pool, objects), objects, client, nil)
	if err := worker.Work(ctx, queuedDocumentTextSyncJob(t, env, created.ID, 1)); err != nil {
		t.Fatalf("sync tabbed filename: %v", err)
	}
	finishDocumentTextSyncJobs(t, env, created.ID)
	if want := "Größe plan-" + suffix + ".txt"; sentFilename != want {
		t.Fatalf("normalizer received filename %q, want %q", sentFilename, want)
	}
	page := searchDocuments(t, env, alice, url.Values{"q": {"narwhal-" + suffix}, "tenant_id": {acmeTenant}})
	if len(page.Items) != 1 || page.Items[0].ID != created.ID || page.Items[0].SearchMatch == nil ||
		page.Items[0].SearchMatch.BodyIndexStatus != "ready" {
		t.Fatalf("tabbed filename body search items=%+v", page.Items)
	}
}

// searchTextRecordingNormalizer records the source it receives and returns markdown.
type searchTextRecordingNormalizer struct {
	received *documenttext.NormalizationSource
	markdown string
}

func (n searchTextRecordingNormalizer) Normalize(_ context.Context, source documenttext.NormalizationSource) (documenttext.NormalizedDocument, error) {
	*n.received = source
	return documenttext.NormalizedDocument{Status: documenttext.StatusReady, Markdown: []byte(n.markdown)}, nil
}

// TestDocumentTextSyncDoesNotOverwriteNewerSource checks the guarded upsert: a
// sync that extracted an older version cannot overwrite the text of the current one.
func TestDocumentTextSyncDoesNotOverwriteNewerSource(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newSearchTextEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	documentID := uploadSearchDocument(t, env, alice, "search-body-guard-"+suffix, "guard-"+suffix+".txt")
	var currentVersionID string
	if err := env.pool.QueryRow(ctx, `select current_version_id from documents where id=$1`, documentID).Scan(&currentVersionID); err != nil {
		t.Fatal(err)
	}
	queries := store.New(env.pool)
	stale := store.UpsertDocumentTextParams{
		DocumentID: documentID, SourceKind: "file_version", SourceID: "version_superseded",
		Status: documenttext.StatusReady, Markdown: "superseded body", SearchText: "superseded body",
		MarkdownSha256: pgtype.Text{String: strings.Repeat("c", 64), Valid: true},
	}
	if rows, err := queries.UpsertDocumentText(ctx, stale); err != nil || rows != 0 {
		t.Fatalf("an older source must not be written, rows=%d err=%v", rows, err)
	}
	current := stale
	current.SourceID = currentVersionID
	current.SearchText = "current body"
	if rows, err := queries.UpsertDocumentText(ctx, current); err != nil || rows != 1 {
		t.Fatalf("the current source must be written, rows=%d err=%v", rows, err)
	}
	if rows, err := queries.UpsertDocumentText(ctx, stale); err != nil || rows != 0 {
		t.Fatalf("a late sync for an older source must not overwrite the current body, rows=%d err=%v", rows, err)
	}
	var body string
	if err := env.pool.QueryRow(ctx, `select search_text from document_texts where document_id=$1`, documentID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "current body" {
		t.Fatalf("body=%q", body)
	}
}

// TestDocumentTextFailureWaitsForANewVersion checks that a final failure is
// recorded for its version, and only a new version queues another sync.
func TestDocumentTextFailureWaitsForANewVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newSearchTextEnv(t)
	ctx := context.Background()
	suffix := hex.EncodeToString([]byte(time.Now().UTC().Format("150405.000000")))
	filename := "failed-" + suffix + ".txt"
	documentID := uploadSearchDocument(t, env, alice, "search-body-failed-"+suffix, filename)
	worker := newSearchTextFixtureWorker(env, searchTextFixtureNormalizer{err: errors.New("normalizer unavailable")})
	// A non-final failure is recorded and returned for River to retry.
	if err := worker.Work(ctx, queuedDocumentTextSyncJob(t, env, documentID, 1)); err == nil {
		t.Fatal("a non-final failure must be returned for River to retry")
	}
	backOffDocumentTextSyncJobs(t, env, documentID)
	// The sixth attempt is the final one; it records the failure instead of retrying.
	if err := worker.Work(ctx, queuedDocumentTextSyncJob(t, env, documentID, 6)); err != nil {
		t.Fatalf("the final attempt records its failure: %v", err)
	}
	finishDocumentTextSyncJobs(t, env, documentID)
	var currentVersionID string
	if err := env.pool.QueryRow(ctx, `select current_version_id from documents where id=$1`, documentID).Scan(&currentVersionID); err != nil {
		t.Fatal(err)
	}
	if status, sourceID := documentTextRow(t, env, documentID); status != "failed" || sourceID != currentVersionID {
		t.Fatalf("status=%q source=%q", status, sourceID)
	}
	if got := documentTextSyncJobCount(t, env, documentID); got != 0 {
		t.Fatalf("a failed version must not be queued again, jobs=%d", got)
	}
	status, _, body := requestUnifiedDocumentVersionUpload(t, env, alice, documentID, "search-body-failed-v2-"+suffix,
		map[string]string{
			"expected_current_version_id": currentVersionID,
			"filename":                    filename, "representation_format": "plain_text", "media_type": "text/plain",
		}, filename, []byte("second Version bytes"))
	if status != http.StatusCreated {
		t.Fatalf("upload second Version status=%d body=%s", status, body)
	}
	if got := documentTextSyncJobCount(t, env, documentID); got != 1 {
		t.Fatalf("a new Version must queue a sync, jobs=%d", got)
	}
}

// documentTextSyncJobCount counts queued text sync jobs for one Document.
func documentTextSyncJobCount(t *testing.T, env *testEnv, documentID string) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*) FROM river_job
		WHERE kind='document_text.sync' AND queue='indexing'
		  AND state IN ('available','pending','running','scheduled')
		  AND args->>'document_id'=$1`, documentID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// queuedDocumentTextSyncJob returns a Document's newest unfinished sync job as
// the worker receives it on the given attempt.
func queuedDocumentTextSyncJob(t *testing.T, env *testEnv, documentID string, attempt int) *river.Job[documenttext.SyncArgs] {
	t.Helper()
	var encoded []byte
	if err := env.pool.QueryRow(t.Context(), `
		SELECT args FROM river_job
		WHERE kind='document_text.sync' AND args->>'document_id'=$1
		  AND state IN ('available','pending','retryable','running','scheduled')
		ORDER BY id DESC LIMIT 1`, documentID).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	var args documenttext.SyncArgs
	if err := json.Unmarshal(encoded, &args); err != nil {
		t.Fatal(err)
	}
	return &river.Job[documenttext.SyncArgs]{JobRow: &rivertype.JobRow{Attempt: attempt}, Args: args}
}

// backOffDocumentTextSyncJobs moves queued sync jobs into their backoff, as River
// does after an attempt returns an error.
func backOffDocumentTextSyncJobs(t *testing.T, env *testEnv, documentIDs ...string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE river_job SET state='retryable',attempt=attempt+1,attempted_at=now(),scheduled_at=now()+interval '1 hour'
		WHERE kind='document_text.sync' AND state='available' AND args->>'document_id'=ANY($1)`, documentIDs); err != nil {
		t.Fatal(err)
	}
}

// documentTextRow returns the status and source of a Document's text row.
func documentTextRow(t *testing.T, env *testEnv, documentID string) (status, sourceID string) {
	t.Helper()
	if err := env.pool.QueryRow(t.Context(),
		`SELECT status,source_id FROM document_texts WHERE document_id=$1`, documentID).Scan(&status, &sourceID); err != nil {
		t.Fatal(err)
	}
	return status, sourceID
}

// finishDocumentTextSyncJobs marks a Document's sync jobs finished, as River does
// after an attempt that returns.
func finishDocumentTextSyncJobs(t *testing.T, env *testEnv, documentID string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE river_job SET state='completed',finalized_at=now()
		WHERE kind='document_text.sync' AND args->>'document_id'=$1`, documentID); err != nil {
		t.Fatal(err)
	}
}

// newSearchTextEnv builds the Room Document env without the background text
// worker, so a test that drives syncs by hand is the only one taking its jobs.
func newSearchTextEnv(t *testing.T) (*testEnv, *http.Client) {
	return newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		appOptions: []appOption{skipping(app.DocumentTextJobs)},
	})
}

// newSearchTextFixtureWorker builds the sync worker over the integration
// database. Every file Version serves the same bytes, and the normalizer is
// the test's double.
func newSearchTextFixtureWorker(env *testEnv, normalizer documenttext.Normalizer) *documenttext.Worker {
	return documenttext.NewWorker(store.New(env.pool), searchTextFixtureDocuments{}, searchTextFixtureObjects{}, normalizer, nil)
}

const searchTextFixtureBody = "fixture source bytes"

type searchTextFixtureDocuments struct{}

func (searchTextFixtureDocuments) LatestDocumentRuntimeProjection(context.Context, string) (document.LatestRuntimeProjection, error) {
	return document.LatestRuntimeProjection{}, document.ErrNotFound
}

func (searchTextFixtureDocuments) GetTenantVersionContent(_ context.Context, _, versionID string) (document.VersionContent, error) {
	return document.VersionContent{
		Version:   document.Version{ID: versionID, MediaType: "text/plain", SizeBytes: int64(len(searchTextFixtureBody))},
		ObjectKey: versionID,
	}, nil
}

type searchTextFixtureObjects struct{}

func (searchTextFixtureObjects) Open(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader(searchTextFixtureBody)), nil
}

// searchTextFixtureNormalizer returns markdown, or the configured error.
type searchTextFixtureNormalizer struct {
	markdown string
	err      error
}

func (n searchTextFixtureNormalizer) Normalize(context.Context, documenttext.NormalizationSource) (documenttext.NormalizedDocument, error) {
	if n.err != nil {
		return documenttext.NormalizedDocument{}, n.err
	}
	return documenttext.NormalizedDocument{Status: documenttext.StatusReady, Markdown: []byte(n.markdown)}, nil
}
