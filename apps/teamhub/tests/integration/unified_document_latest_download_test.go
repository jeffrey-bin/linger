package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"

	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentLatestDownloadUsesOrdinaryCurrentVersionWithoutRuntime(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	contents := []byte("%PDF-current-ordinary-bytes")
	object, err := objects.Put(ctx, bytes.NewReader(contents))
	if err != nil {
		t.Fatal(err)
	}
	sha := hex.EncodeToString(object.SHA256[:])
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES('document_latest_ordinary','tenant_document_a','ordinary.pdf','pdf',
		'actor_human_a','human','actor_human_a','human','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES('version_latest_ordinary','tenant_document_a','document_latest_ordinary',1,
		'ordinary.pdf','pdf','application/pdf',$1,$2,$3,'ordinary_upload','actor_human_a')`,
		len(contents), sha, object.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE documents
		SET current_version_id='version_latest_ordinary'
		WHERE id='document_latest_ordinary'`); err != nil {
		t.Fatal(err)
	}
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(
		context.Context, document.ExportRuntimeRequest,
	) (document.ExportRuntimeResult, error) {
		runtimeCalls++
		return document.ExportRuntimeResult{}, errors.New("unexpected Runtime call")
	}}, objects)

	content, err := service.GetLatestDownloadContent(ctx, document.LatestDownloadInput{
		AccountID: "account_document_a", DocumentID: "document_latest_ordinary",
	})
	if err != nil {
		t.Fatal(err)
	}
	if content.Filename != "ordinary.pdf" || content.ObjectKey != object.Key || runtimeCalls != 0 {
		t.Fatalf("latest ordinary filename=%s object=%s runtime_calls=%d",
			content.Filename, content.ObjectKey, runtimeCalls)
	}
}

func TestUnifiedDocumentLatestDownloadRendersAndRepairsExactNativeProjection(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	state := []byte{0}
	stateHash := sha256.Sum256(state)
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,native_representation_format,owner_actor_id,
		owner_actor_kind,creator_actor_id,creator_actor_kind,status
	) VALUES('document_latest_native','tenant_document_a','Native','blocknote','markdown',
		'actor_human_a','human','actor_human_a','human','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES('revision_latest_native','tenant_document_a','document_latest_native',0,
		'\x00',repeat('c',64),$1,$2,'[]'::jsonb,ARRAY[]::text[],'actor_human_a')`,
		state, hex.EncodeToString(stateHash[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_latest_native','tenant_document_a',0,'\x00',repeat('c',64),
		'revision_latest_native','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`); err != nil {
		t.Fatal(err)
	}
	objectRoot := t.TempDir()
	objects, err := artifactstore.NewLocalStore(objectRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	runtimeCalls := 0
	export := func(
		_ context.Context, request document.ExportRuntimeRequest,
	) (document.ExportRuntimeResult, error) {
		runtimeCalls++
		if request.RevisionID != "revision_latest_native" || request.RepresentationFormat != "markdown" {
			return document.ExportRuntimeResult{}, errors.New("unexpected projection Runtime request")
		}
		projectionBytes := []byte("# Native projection\n")
		digest := sha256.Sum256(projectionBytes)
		return document.ExportRuntimeResult{
			MediaType: "text/markdown", Bytes: projectionBytes, SizeBytes: int64(len(projectionBytes)),
			SHA256: hex.EncodeToString(digest[:]), CompleteAssetIDs: []string{},
			CompleteThreadIDs: []string{}, Warnings: []string{},
		}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: export}, objects)
	input := document.LatestDownloadInput{
		AccountID: "account_document_a", DocumentID: "document_latest_native",
	}
	withoutRuntime := document.NewWithObjectStore(pool, objects)
	if _, err := withoutRuntime.GetLatestDownloadContent(ctx, input); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("native latest without materializer error=%v", err)
	}
	pendingErrors := make(chan error, 8)
	var pendingWait sync.WaitGroup
	for attempt := 0; attempt < 8; attempt++ {
		pendingWait.Add(1)
		go func() {
			defer pendingWait.Done()
			_, err := service.GetLatestDownloadContent(ctx, input)
			pendingErrors <- err
		}()
	}
	pendingWait.Wait()
	close(pendingErrors)
	for err := range pendingErrors {
		if err != nil {
			t.Fatalf("concurrent on-demand download error=%v", err)
		}
	}
	if runtimeCalls != 1 {
		t.Fatalf("concurrent miss rendered %d times, want once", runtimeCalls)
	}
	content, err := service.GetLatestDownloadContent(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	object, err := objects.Head(ctx, content.ObjectKey)
	if err != nil {
		t.Fatal(err)
	}
	if content.Filename != "latest.md" || runtimeCalls != 1 {
		t.Fatalf("download=%+v calls=%d", content, runtimeCalls)
	}
	cachedWithoutRuntime, err := withoutRuntime.GetLatestDownloadContent(ctx, input)
	if err != nil || cachedWithoutRuntime.ObjectKey != object.Key {
		t.Fatalf("cached without runtime=%+v error=%v", cachedWithoutRuntime, err)
	}
	if err := os.WriteFile(filepath.Join(objectRoot, object.Key), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := service.GetLatestDownloadContent(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if rebuilt.SHA256 != hex.EncodeToString(object.SHA256[:]) || runtimeCalls != 2 {
		t.Fatalf("rebuilt projection sha=%s runtime_calls=%d", rebuilt.SHA256, runtimeCalls)
	}
	if repairedBytes, err := os.ReadFile(filepath.Join(objectRoot, rebuilt.ObjectKey)); err != nil || string(repairedBytes) != "# Native projection\n" {
		t.Fatalf("repaired projection bytes=%q error=%v", repairedBytes, err)
	}
	link, err := service.SetLinkShare(ctx, document.SetLinkShareInput{
		Principal:  document.LinkSharePrincipal{AccountID: input.AccountID},
		DocumentID: input.DocumentID, Role: "viewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, failure := range []string{"corrupt", "missing"} {
		if failure == "corrupt" {
			err = os.WriteFile(filepath.Join(objectRoot, rebuilt.ObjectKey), []byte("corrupt again"), 0o600)
		} else {
			err = os.Remove(filepath.Join(objectRoot, rebuilt.ObjectKey))
		}
		if err != nil {
			t.Fatal(err)
		}
		if downloaded, err := service.DownloadLinkFile(ctx, link.Token); err != nil || !downloaded.ReadOnly || downloaded.SHA256 != rebuilt.SHA256 {
			t.Fatalf("CLI repaired native download=%+v error=%v", downloaded, err)
		}
	}
	// The Agent reads the Human's Document without a share.
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := service.DownloadAgentFileAs(ctx, "tenant_document_a", "agent_document_a", input.DocumentID, "markdown"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnifiedDocumentLatestReadsRenderOnlyRequestedPersonalFormats(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, unifiedDocumentIdentityFixtureSQL)
	state := []byte{0}
	stateHash := sha256.Sum256(state)
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,native_representation_format,owner_actor_id,
		owner_actor_kind,creator_actor_id,creator_actor_kind,status
	) VALUES('document_projection_personal','tenant_document_a','Personal HTML','blocknote','html',
		'actor_human_a','human','actor_human_a','human','active')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES('revision_projection_personal','tenant_document_a','document_projection_personal',0,
		'\x00',repeat('d',64),$1,$2,'[]'::jsonb,ARRAY[]::text[],'actor_human_a')`,
		state, hex.EncodeToString(stateHash[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_projection_personal','tenant_document_a',0,'\x00',repeat('d',64),
		'revision_projection_personal','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,native_representation_format,owner_actor_id,
		owner_actor_kind,creator_actor_id,creator_actor_kind,status,updated_at
	) VALUES('document_projection_broken','tenant_document_a','Broken','blocknote','markdown',
		'actor_human_a','human','actor_human_a','human','active','2000-01-01')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
	) VALUES('revision_projection_broken','tenant_document_a','document_projection_broken',0,
		'\x00',repeat('e',64),$1,$2,'[]'::jsonb,ARRAY[]::text[],'actor_human_a')`,
		state, hex.EncodeToString(stateHash[:])); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids,updated_at) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[],draft.updated_at::timestamptz FROM (VALUES ('document_projection_broken','tenant_document_a',0,'\x00',repeat('e',64),
		'revision_projection_broken','actor_human_a','2000-01-01')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id,updated_at) JOIN document_revisions revision ON revision.id=draft.current_revision_id`); err != nil {
		t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	calls := make([]string, 0, 2)
	exporter := func(
		_ context.Context, input document.ExportRuntimeRequest,
	) (document.ExportRuntimeResult, error) {
		calls = append(calls, input.RepresentationFormat)
		if input.RevisionID == "revision_projection_broken" {
			return document.ExportRuntimeResult{}, errors.New("permanent broken revision")
		}
		contents := []byte("# projection\n")
		mediaType := "text/markdown"
		if input.RepresentationFormat == "html" {
			contents = []byte("<h1>projection</h1>\n")
			mediaType = "text/html"
		}
		digest := sha256.Sum256(contents)
		return document.ExportRuntimeResult{
			MediaType: mediaType, Bytes: contents, SizeBytes: int64(len(contents)),
			SHA256: hex.EncodeToString(digest[:]), CompleteAssetIDs: []string{},
			CompleteThreadIDs: []string{}, Warnings: []string{},
		}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: exporter}, objects)
	if _, err := service.LatestDocumentRuntimeProjection(ctx, "document_projection_personal"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetLatestDownloadContent(ctx, document.LatestDownloadInput{AccountID: "account_document_a", DocumentID: "document_projection_personal"}); err != nil {
		t.Fatal(err)
	}
	var markdown, html, broken int
	if err := db.QueryRowContext(ctx, `SELECT
		count(*) FILTER(WHERE representation_format='markdown'),
		count(*) FILTER(WHERE representation_format='html'),
		count(*) FILTER(WHERE document_id='document_projection_broken')
		FROM document_latest_projections
		WHERE document_id IN ('document_projection_personal','document_projection_broken')`).Scan(
		&markdown, &html, &broken,
	); err != nil {
		t.Fatal(err)
	}
	slices.Sort(calls)
	if markdown != 1 || html != 1 || broken != 0 ||
		!slices.Equal(calls, []string{"html", "markdown"}) {
		t.Fatalf("personal projections markdown=%d html=%d broken=%d calls=%v",
			markdown, html, broken, calls)
	}
}
