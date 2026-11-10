package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func wikiSourceExportService(t *testing.T, pool *pgxpool.Pool, markdown string) *document.Service {
	t.Helper()
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	return document.NewWithRuntime(pool, documentRuntimeStub{export: func(_ context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		content := []byte(markdown)
		if markdown == "revision" {
			content = []byte("# " + input.RevisionID + "\n")
		}
		digest := sha256.Sum256(content)
		return document.ExportRuntimeResult{
			MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]),
			CompleteAssetIDs: append([]string{}, input.CompleteAssetIDs...), CompleteThreadIDs: append([]string{}, input.CompleteThreadIDs...), Warnings: []string{},
		}, nil
	}}, objects)
}

func verifyMyPagesWikiSources(t *testing.T) {
	ctx := t.Context()
	db, pool := newUnifiedWikiFixture(t, "")
	service := wikiSourceExportService(t, pool, "revision")
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a' WHERE actor_id='actor_agent_a';
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',0,'\x00',repeat('c',64),'revision_human_a','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,sort_key)
		VALUES('placement_wiki_native','tenant_document_a','personal','actor_human_a','document','document_human_a','a')`); err != nil {
		t.Fatal(err)
	}
	upload := func(name, format, media string) document.Document {
		value, err := service.Upload(ctx, document.UploadDocumentInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-upload-" + name,
			Filename: name, RepresentationFormat: format, MediaType: media, Content: bytes.NewBufferString("Test source"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return value.Document
	}
	text := upload("notes.txt", "plain_text", "text/plain")
	audio := upload("clip.mp3", "mp3", "audio/mpeg")
	unknown := upload("unknown.bin", "binary", "application/octet-stream")
	archive := upload("bundle.zip", "zip", "application/zip")
	zippedOffice := upload("report.docx", "docx", "application/zip")
	// Prose formats enter the Wiki; spreadsheets stay searchable but out of it.
	localSources, spreadsheets := []document.Document{}, []document.Document{}
	for _, format := range []struct{ extension, media string }{
		{"odt", "application/vnd.oasis.opendocument.text"},
		{"ods", "application/vnd.oasis.opendocument.spreadsheet"},
		{"odp", "application/vnd.oasis.opendocument.presentation"},
		{"epub", "application/epub+zip"},
		{"eml", "message/rfc822"},
		{"mhtml", "multipart/related"},
		{"dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.template"},
		{"potx", "application/vnd.openxmlformats-officedocument.presentationml.template"},
		{"ppsx", "application/vnd.openxmlformats-officedocument.presentationml.slideshow"},
		{"xltx", "application/vnd.openxmlformats-officedocument.spreadsheetml.template"},
	} {
		uploaded := []document.Document{
			upload("local."+format.extension, format.extension, format.media),
			upload("generic."+format.extension, format.extension, "application/octet-stream"),
		}
		if format.extension != "eml" && format.extension != "mhtml" {
			uploaded = append(uploaded, upload("zipped."+format.extension, format.extension, "application/zip"))
		}
		if format.extension == "ods" || format.extension == "xltx" {
			spreadsheets = append(spreadsheets, uploaded...)
		} else {
			localSources = append(localSources, uploaded...)
		}
	}

	copy, err := service.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: text.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	originals := make(map[string]document.Document)
	originalVersions := make(map[string]document.Page[document.Version])
	for _, documentID := range []string{"document_human_a", text.ID, audio.ID, unknown.ID, archive.ID, zippedOffice.ID, copy.Document.ID} {
		originals[documentID], err = service.Get(ctx, "account_document_a", documentID)
		if err != nil {
			t.Fatal(err)
		}
		originalVersions[documentID], err = service.ListVersions(ctx, document.ListVersionsInput{
			AccountID: "account_document_a", DocumentID: documentID, Limit: 100,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	assertOriginalsUsable := func() {
		t.Helper()
		for documentID, before := range originals {
			after, err := service.Get(ctx, "account_document_a", documentID)
			if err != nil {
				t.Fatal(err)
			}
			if before.Title != after.Title || before.Format != after.Format || before.Owner != after.Owner ||
				before.Capabilities != after.Capabilities || before.CanEditNativeContent != after.CanEditNativeContent ||
				!reflect.DeepEqual(before.CurrentVersion, after.CurrentVersion) {
				t.Fatalf("Wiki refresh changed original Document %s", documentID)
			}
			versions, err := service.ListVersions(ctx, document.ListVersionsInput{
				AccountID: "account_document_a", DocumentID: documentID, Limit: 100,
			})
			if err != nil || !reflect.DeepEqual(versions, originalVersions[documentID]) {
				t.Fatalf("Wiki snapshots changed visible file history for %s: %v", documentID, err)
			}
			if before.CurrentVersion != nil {
				if _, err := service.GetVersionContent(ctx, "account_document_a", before.CurrentVersion.ID); err != nil {
					t.Fatalf("original file %s no longer downloadable: %v", documentID, err)
				}
			}
		}
	}
	request := func(key string) document.WikiRefreshResult {
		readyDocumentTexts(t, pool, nil, service)
		value, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key,
		})
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	first := request("wiki-my-pages-first")
	assertOriginalsUsable()
	if first.Status != document.WikiRefreshAccepted || addedWikiSources(t, db, first.ID) != 4+len(localSources) {
		t.Fatalf("My pages admission=%+v", first)
	}
	var count int
	for _, source := range localSources {
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1 AND document_id=$2`, first.ID, source.ID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("local format source %s was not frozen: count=%d error=%v", source.Title, count, err)
		}
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1 AND document_id IN ($2,$3,$4,$5)`,
		first.ID, "document_human_a", text.ID, zippedOffice.ID, copy.Document.ID).Scan(&count); err != nil || count != 4 {
		t.Fatalf("native, upload, ZIP-typed Office and copy sources=%d error=%v", count, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1 AND document_id IN ($2,$3,$4)`,
		first.ID, audio.ID, unknown.ID, archive.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unsupported sources=%d error=%v", count, err)
	}
	reasons := wikiVerdictReasons(t, db, "tenant_document_a")
	for _, source := range append([]document.Document{audio, unknown, archive}, spreadsheets...) {
		if reasons[source.ID] != "unsupported_type" {
			t.Fatalf("%s skip reason=%q in %+v", source.Title, reasons[source.ID], reasons)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_wiki_published_sources(wiki_id,tenant_id,document_id,document_version_id)
		SELECT 'wiki_document_a',tenant_id,document_id,frozen_document_version_id
		FROM document_wiki_refresh_sources WHERE refresh_id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE personal_wikis SET current_revision_id='wiki_my_pages_published',
		published_at=clock_timestamp() WHERE id='wiki_document_a'`); err != nil {
		t.Fatal(err)
	}
	if latest := request("wiki-my-pages-latest"); latest.Status != document.WikiRefreshAlreadyLatest {
		t.Fatalf("unchanged Wiki=%+v", latest)
	}
	assertOriginalsUsable()
	if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
		SELECT 'revision_wiki_edited',tenant_id,document_id,1,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		FROM document_revisions WHERE id='revision_human_a';
		UPDATE document_bodies SET seq=1,state=(SELECT state_bytes FROM document_revisions WHERE id='revision_wiki_edited'),state_vector=(SELECT state_vector FROM document_revisions WHERE id='revision_wiki_edited') WHERE document_id='document_human_a';
		SELECT enqueue_document_text_sync('document_human_a')`); err != nil {
		t.Fatal(err)
	}
	edited := request("wiki-my-pages-edited")
	if edited.Status != document.WikiRefreshAccepted {
		t.Fatalf("edited Wiki=%+v", edited)
	}
	assertOriginalsUsable()
	var revisionID string
	if err := db.QueryRowContext(ctx, `SELECT revision.id FROM document_wiki_refresh_sources source
		JOIN document_revisions revision ON revision.document_id=source.document_id
		 AND document_text_version_id(source.document_id,'native_body',revision.persisted_seq::text)=source.frozen_document_version_id
		WHERE source.refresh_id=$1 AND source.document_id='document_human_a'`, edited.ID).Scan(&revisionID); err != nil || revisionID != "revision_wiki_edited" {
		t.Fatalf("frozen native revision=%s error=%v", revisionID, err)
	}
}

// Sizes are rewritten in place: admission sizes the batch from stored
// metadata so the candidate request stays within the LLM Wiki budget.
func verifyWikiRefreshRequestBudget(t *testing.T) {
	ctx := t.Context()
	db, pool := newUnifiedWikiFixture(t, "")
	service := wikiSourceExportService(t, pool, "revision")
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a' WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	versionIDs := make([]string, 0, 5)
	for index := range 5 {
		value, err := service.Upload(ctx, document.UploadDocumentInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: fmt.Sprintf("wiki-budget-%d", index),
			Filename: fmt.Sprintf("budget-%d.txt", index), RepresentationFormat: "plain_text", MediaType: "text/plain",
			Content: bytes.NewBufferString("budget source"),
		})
		if err != nil {
			t.Fatal(err)
		}
		versionIDs = append(versionIDs, value.Document.CurrentVersion.ID)
	}
	// Five 45 MiB texts pass the 50 MiB source check but encode to ~300 MiB.
	// The budget reads a source's text, so the texts are what grow, in lines
	// the Wiki can cut them at.
	readyDocumentTexts(t, pool, nil, service)
	resize := func(size int64) {
		t.Helper()
		if _, err := db.ExecContext(ctx, `UPDATE document_texts text SET markdown=rpad('',`+fmt.Sprint(size)+`,repeat('x',1023)||E'\n'),
			longest_line_bytes=1023
			FROM documents document WHERE document.id=text.document_id
			  AND document.current_version_id IN ('`+strings.Join(versionIDs, "','")+`')`); err != nil {
			t.Fatal(err)
		}
	}
	request := func(key string) (document.WikiRefreshResult, error) {
		return service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key,
		})
	}
	// Each source encodes to 60 MiB, so four of the five fit the 256 MiB budget.
	resize(45 << 20)
	admitted, err := request("wiki-budget-batch")
	if err != nil || admitted.Status != document.WikiRefreshAccepted || addedWikiSources(t, db, admitted.ID) != 4 {
		t.Fatalf("oversized change set admission=%+v error=%v", admitted, err)
	}
	var frozen int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1`, admitted.ID).Scan(&frozen); err != nil || frozen != 4 {
		t.Fatalf("budget batch frozen=%d error=%v", frozen, err)
	}
}

// LLM Wiki takes at most 1,000 added, modified, and removed sources per
// request. A larger change set, such as a 3,000-message mail import, is
// admitted in batches: each refresh freezes the unchanged sources and the next
// changes that fit, and a modified source left for later keeps its published
// version so the following refresh still sees it as modified.
func verifyWikiRefreshSourceCountLimit(t *testing.T) {
	ctx := t.Context()
	db, pool := newUnifiedWikiFixture(t, `
		UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a';
		INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
		SELECT 'document_count_'||lpad(n::text,4,'0'),'tenant_document_a','Count '||n,'plain_text','actor_human_a','human','actor_human_a','human','active'
		FROM generate_series(1,$1::int) n;
		INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id)
		SELECT 'version_count_'||lpad(n::text,4,'0'),'tenant_document_a','document_count_'||lpad(n::text,4,'0'),1,'count-'||n||'.txt','plain_text','text/plain',
			1,repeat('a',64),'object_count_'||n,'ordinary_upload','actor_human_a'
		FROM generate_series(1,$1::int) n;
		UPDATE documents SET current_version_id=replace(id,'document_','version_') WHERE id LIKE 'document_count_%';
		INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status)
		SELECT 'binding_count_'||n,'tenant_document_a','document_count_'||lpad(n::text,4,'0'),'wiki_source','wiki_document_a','active'
		FROM generate_series(1,$1::int) n;`, 1001)
	service := wikiSourceExportService(t, pool, "revision")
	request := func(key string) document.WikiRefreshResult {
		t.Helper()
		readyDocumentTexts(t, pool, nil, service)
		admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key,
		})
		if err != nil || admission.Status != document.WikiRefreshAccepted {
			t.Fatalf("%s admission=%+v error=%v", key, admission, err)
		}
		return admission
	}
	frozenVersion := func(refreshID, documentID string) string {
		t.Helper()
		var version string
		err := db.QueryRowContext(ctx, `SELECT coalesce((SELECT frozen_document_version_id FROM document_wiki_refresh_sources
			WHERE refresh_id=$1 AND document_id=$2),'')`, refreshID, documentID).Scan(&version)
		if err != nil {
			t.Fatal(err)
		}
		return version
	}
	deferred := func(refreshID string) bool {
		t.Helper()
		var value bool
		if err := db.QueryRowContext(ctx, `SELECT sources_deferred FROM document_wiki_refreshes WHERE id=$1`, refreshID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	frozenCount := func(refreshID string) int {
		t.Helper()
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1`, refreshID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	// Settlement publishes exactly the frozen sources; the generated pages do
	// not matter to admission.
	publish := func(refreshID string, generation int) {
		t.Helper()
		revisionID := fmt.Sprintf("revision_count_%d", generation)
		for _, statement := range []struct {
			sql       string
			arguments []any
		}{
			{`DELETE FROM document_wiki_published_sources WHERE wiki_id='wiki_document_a'`, nil},
			{`INSERT INTO document_wiki_published_sources(wiki_id,tenant_id,document_id,document_version_id)
				SELECT 'wiki_document_a',tenant_id,document_id,frozen_document_version_id
				FROM document_wiki_refresh_sources WHERE refresh_id=$1`, []any{refreshID}},
			{`UPDATE personal_wikis SET current_revision_id=$1,published_generation=$2,published_at=clock_timestamp()
				WHERE id='wiki_document_a'`, []any{revisionID, generation}},
			{`UPDATE document_wiki_refreshes SET status='settled',outcome='applied',result_wiki_revision_id=$1 WHERE id=$2`, []any{revisionID, refreshID}},
		} {
			if _, err := db.ExecContext(ctx, statement.sql, statement.arguments...); err != nil {
				t.Fatal(err)
			}
		}
	}

	// 1,001 added sources: the first 1,000 in document order.
	first := request("wiki-count-first")
	// A batch that leaves changes out records it, so its settlement queues
	// the next batch.
	if count := frozenCount(first.ID); count != 1000 || addedWikiSources(t, db, first.ID) != 1000 || frozenVersion(first.ID, "document_count_1001") != "" ||
		!deferred(first.ID) {
		t.Fatalf("first batch frozen=%d deferred=%v", count, deferred(first.ID))
	}
	publish(first.ID, 1)
	// The last source arrives, and one published source gains a version; both
	// fit one refresh, which carries the 999 unchanged sources along.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id)
		VALUES('version_count_0001_b','tenant_document_a','document_count_0001',2,'count-1.txt','plain_text','text/plain',
			1,repeat('b',64),'object_count_1b','ordinary_upload','actor_human_a');
		UPDATE documents SET current_version_id='version_count_0001_b' WHERE id='document_count_0001'`); err != nil {
		t.Fatal(err)
	}
	second := request("wiki-count-second")
	if count := frozenCount(second.ID); count != 1001 || addedWikiSources(t, db, second.ID) != 1 ||
		frozenVersion(second.ID, "document_count_0001") != "version_count_0001_b" ||
		frozenVersion(second.ID, "document_count_1001") != "version_count_1001" || deferred(second.ID) {
		t.Fatalf("second batch frozen=%d", count)
	}
	publish(second.ID, 2)
	// 1,000 new sources sorting before a modified one: the modified source
	// misses the batch and keeps its published version.
	if _, err := db.ExecContext(ctx, `
		INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
		SELECT 'document_count_0000_'||lpad(n::text,4,'0'),'tenant_document_a','Early '||n,'plain_text','actor_human_a','human','actor_human_a','human','active'
		FROM generate_series(1,1000) n;
		INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id)
		SELECT 'version_count_0000_'||lpad(n::text,4,'0'),'tenant_document_a','document_count_0000_'||lpad(n::text,4,'0'),1,'early-'||n||'.txt','plain_text','text/plain',
			1,repeat('a',64),'object_early_'||n,'ordinary_upload','actor_human_a'
		FROM generate_series(1,1000) n;
		UPDATE documents SET current_version_id=replace(id,'document_','version_') WHERE id LIKE 'document_count_0000_%';
		INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status)
		SELECT 'binding_early_'||n,'tenant_document_a','document_count_0000_'||lpad(n::text,4,'0'),'wiki_source','wiki_document_a','active'
		FROM generate_series(1,1000) n;
		INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id)
		VALUES('version_count_1001_b','tenant_document_a','document_count_1001',2,'count-1001.txt','plain_text','text/plain',
			1,repeat('b',64),'object_count_1001b','ordinary_upload','actor_human_a');
		UPDATE documents SET current_version_id='version_count_1001_b' WHERE id='document_count_1001'`); err != nil {
		t.Fatal(err)
	}
	third := request("wiki-count-third")
	if count := frozenCount(third.ID); count != 2001 || addedWikiSources(t, db, third.ID) != 1000 ||
		frozenVersion(third.ID, "document_count_1001") != "version_count_1001" || !deferred(third.ID) {
		t.Fatalf("third batch frozen=%d version=%s", count, frozenVersion(third.ID, "document_count_1001"))
	}
	publish(third.ID, 3)
	fourth := request("wiki-count-fourth")
	if count := frozenCount(fourth.ID); count != 2001 || addedWikiSources(t, db, fourth.ID) != 0 ||
		frozenVersion(fourth.ID, "document_count_1001") != "version_count_1001_b" || deferred(fourth.ID) {
		t.Fatalf("fourth batch frozen=%d", count)
	}
}

// A page an update drops keeps its Document; a later update that writes the
// same key again revives that Document with a new Version.
func TestWikiUpdateRevivesDroppedPageDocument(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{
		{PageKey: "index.md", Markdown: []byte("# Index\n")}, {PageKey: "guide/page.md", Markdown: []byte("# Page\n")},
	}}}
	f := newUnifiedWikiDispatchCase(t, "revive", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}, "replaceable")
	if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, f.admission.ID); err != nil || !worked {
		t.Fatalf("initial publication worked=%v err=%v", worked, err)
	}
	// refresh uploads a new source Version so the update has a change, then
	// publishes exactly pageKeys.
	refresh := func(key string, pageKeys ...string) {
		t.Helper()
		var current string
		if err := f.pool.QueryRow(f.ctx, `SELECT current_version_id FROM documents WHERE id='document_wiki_replaceable_source'`).Scan(&current); err != nil {
			t.Fatal(err)
		}
		if _, err := f.service.UploadVersion(f.ctx, document.UploadDocumentVersionInput{AccountID: "account_document_a", DocumentID: "document_wiki_replaceable_source",
			ExpectedCurrentVersionID: current, IdempotencyKey: key, Filename: "source.txt", RepresentationFormat: "plain_text",
			MediaType: "text/plain", Content: bytes.NewBufferString(key)}); err != nil {
			t.Fatal(err)
		}
		readyDocumentTexts(t, f.pool, f.objects, nil)
		generator.response.Pages = nil
		for _, pageKey := range pageKeys {
			generator.response.Pages = append(generator.response.Pages, document.WikiPageCandidate{PageKey: pageKey, Markdown: []byte("# " + key + "\n")})
		}
		admission, err := f.service.RequestWikiRefresh(f.ctx, document.RequestWikiRefreshInput{AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key})
		if err != nil || admission.Status != document.WikiRefreshAccepted {
			t.Fatalf("%s admission=%+v err=%v", key, admission, err)
		}
		var status string
		if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, admission.ID); err != nil || !worked {
			t.Fatalf("%s worked=%v err=%v", key, worked, err)
		} else if err := f.pool.QueryRow(f.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, admission.ID).Scan(&status); err != nil || status != "settled" {
			t.Fatalf("%s status=%s err=%v", key, status, err)
		}
		if calls := generator.callsSnapshot(); calls[len(calls)-1].Mode != "update" {
			t.Fatalf("%s mode=%s", key, calls[len(calls)-1].Mode)
		}
	}
	// page reports the Document, the hash of the current Version, whether the
	// page Binding is active and the Version count of one page key.
	page := func(pageKey string) (documentID, markdownSHA256 string, active bool, versions int) {
		t.Helper()
		if err := f.pool.QueryRow(f.ctx, `SELECT page.document_id,version.sha256,
			EXISTS(SELECT 1 FROM document_context_bindings binding WHERE binding.document_id=page.document_id
			  AND binding.binding_kind='wiki_page' AND binding.status='active'),
			(SELECT count(*) FROM document_versions WHERE document_id=page.document_id)
			FROM document_wiki_pages page
			JOIN documents document ON document.id=page.document_id
			JOIN document_versions version ON version.id=document.current_version_id
			WHERE page.wiki_id='wiki_document_a' AND page.page_key=$1`, pageKey).Scan(
			&documentID, &markdownSHA256, &active, &versions); err != nil {
			t.Fatal(err)
		}
		return
	}
	original, _, active, versions := page("guide/page.md")
	if !active || versions != 1 {
		t.Fatalf("initial page active=%v versions=%d", active, versions)
	}
	refresh("drop-page", "index.md")
	if id, _, active, versions := page("guide/page.md"); id != original || active || versions != 1 {
		t.Fatalf("dropped page id=%s active=%v versions=%d", id, active, versions)
	}
	refresh("readd-page", "index.md", "guide/page.md")
	digest := sha256.Sum256([]byte("# readd-page\n"))
	if id, markdown, active, versions := page("guide/page.md"); id != original || markdown != hex.EncodeToString(digest[:]) || !active || versions != 2 {
		t.Fatalf("re-added page id=%s markdown=%s active=%v versions=%d", id, markdown, active, versions)
	}
}
