package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentTypedBindingsAreOwnerOnlyAndIdempotent(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := document.New(pool)

	roomInput := document.BindDocumentToRoomInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		RoomID: "room_document_a",
	}
	room, err := service.BindToRoom(ctx, roomInput)
	if err != nil || room.Replayed || !hasUnifiedDocumentSource(room.Document, "room", "room_document_a") {
		t.Fatalf("Room Binding result=%+v error=%v", room, err)
	}
	alreadyActive, err := service.BindToRoom(ctx, document.BindDocumentToRoomInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		RoomID: "room_document_a",
	})
	if err != nil || alreadyActive.Replayed || !hasUnifiedDocumentSource(alreadyActive.Document, "room", "room_document_a") {
		t.Fatalf("already-active Room Binding=%+v error=%v", alreadyActive, err)
	}

	task, err := service.BindToWorkItem(ctx, document.BindDocumentToWorkItemInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		WorkItemID: "work_item_document_a", IdempotencyKey: "bind-document-task-a",
	})
	if err != nil || task.Replayed || !hasUnifiedDocumentSource(task.Document, "task", "work_item_document_a") {
		t.Fatalf("Task Binding result=%+v error=%v", task, err)
	}
	wiki, err := service.BindToPersonalWiki(ctx, document.BindDocumentToPersonalWikiInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		TenantID: "tenant_document_a",
	})
	if err != nil || wiki.Replayed || !hasUnifiedDocumentSource(wiki.Document, "wiki_source", "wiki_document_a") {
		t.Fatalf("Wiki Binding result=%+v error=%v", wiki, err)
	}

	for name, run := range map[string]func() error{
		"unknown Work Item": func() error {
			_, bindErr := service.BindToWorkItem(ctx, document.BindDocumentToWorkItemInput{
				AccountID: "account_document_a", DocumentID: "document_human_a",
				WorkItemID: "work_item_missing", IdempotencyKey: "bind-missing-task",
			})
			return bindErr
		},
	} {
		if bindErr := run(); !errors.Is(bindErr, document.ErrNotFound) {
			t.Fatalf("%s error=%v want not found", name, bindErr)
		}
	}

	var bindings, events, keys int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_context_bindings WHERE document_id='document_human_a'),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a'
		 AND event_type='document.binding_updated'),
		(SELECT count(*) FROM command_replays WHERE operation LIKE 'document.bind.%')
	`).Scan(&bindings, &events, &keys); err != nil {
		t.Fatal(err)
	}
	// Only the keyed Task Binding stores a replay; Room and Wiki Bindings take
	// no key.
	if bindings != 3 || events != 3 || keys != 1 {
		t.Fatalf("typed Binding side effects bindings=%d events=%d keys=%d", bindings, events, keys)
	}
}

func TestUnifiedDocumentWikiRefreshAdmissionUsesActiveAnotherMeAndConvergesNoChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := document.New(pool)
	input := document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-admission",
	}

	if _, err := service.RequestWikiRefresh(ctx, input); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("refresh without active Another Me error=%v", err)
	}
	var refreshCount, keyCount int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_wiki_refreshes),
		(SELECT count(*) FROM command_replays WHERE operation='document.wiki.refresh')
	`).Scan(&refreshCount, &keyCount); err != nil {
		t.Fatal(err)
	}
	if refreshCount != 0 || keyCount != 0 {
		t.Fatalf("failed admission changed refresh facts: refreshes=%d keys=%d", refreshCount, keyCount)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_refresh_source','tenant_document_a','document_human_a',1,
			'source.txt','plain_text','text/plain',1,repeat('1',64),
			'object_wiki_refresh_source','ordinary_upload','actor_human_a'
		);
		UPDATE documents SET format='txt',current_version_id='version_wiki_refresh_source'
		WHERE id='document_human_a';
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_refresh_source','tenant_document_a','document_human_a',
			'wiki_source','wiki_document_a','active'
		);
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'
	`); err != nil {
		t.Fatal(err)
	}

	readyDocumentTexts(t, pool, nil, nil)
	accepted, err := service.RequestWikiRefresh(ctx, input)
	if err != nil || accepted.Replayed || accepted.Status != document.WikiRefreshAccepted ||
		accepted.GeneratorAgentActorID != "actor_agent_a" {
		t.Fatalf("accepted refresh=%+v error=%v", accepted, err)
	}
	replayed, err := service.RequestWikiRefresh(ctx, input)
	if err != nil || !replayed.Replayed || replayed.ID != accepted.ID ||
		replayed.Status != document.WikiRefreshAccepted {
		t.Fatalf("refresh replay=%+v error=%v", replayed, err)
	}
	inProgress, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-while-active",
	})
	if err != nil || inProgress.Replayed || inProgress.ID != accepted.ID ||
		inProgress.Status != document.WikiRefreshInProgress {
		t.Fatalf("in-progress refresh=%+v error=%v", inProgress, err)
	}
	var internalStatus, generatorID, sourceVersionID string
	var sourceCount int
	if err := db.QueryRowContext(ctx, `SELECT refresh.status,refresh.generator_agent_actor_id,
		(SELECT count(*) FROM document_wiki_refresh_sources source WHERE source.refresh_id=refresh.id),
		(SELECT frozen_document_version_id FROM document_wiki_refresh_sources source
		 WHERE source.refresh_id=refresh.id)
		FROM document_wiki_refreshes refresh WHERE refresh.id=$1`, accepted.ID).Scan(
		&internalStatus, &generatorID, &sourceCount, &sourceVersionID,
	); err != nil {
		t.Fatal(err)
	}
	if internalStatus != "staging" || generatorID != "actor_agent_a" ||
		sourceCount != 1 || sourceVersionID != "version_wiki_refresh_source" {
		t.Fatalf("frozen refresh status=%s generator=%s sources=%d version=%s",
			internalStatus, generatorID, sourceCount, sourceVersionID)
	}

	if _, err := db.ExecContext(ctx, `UPDATE document_wiki_refreshes
		SET status='failed',updated_at=clock_timestamp() WHERE id=$1`, accepted.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_wiki_published_sources(
			wiki_id,tenant_id,document_id,document_version_id
		) VALUES(
			'wiki_document_a','tenant_document_a','document_human_a','version_wiki_refresh_source'
		);
		UPDATE personal_wikis
		SET current_revision_id='wiki_revision_document_current',published_generation=1,
			published_at=clock_timestamp(),updated_at=clock_timestamp()
		WHERE id='wiki_document_a'
	`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refreshes`).Scan(&refreshCount); err != nil {
		t.Fatal(err)
	}
	alreadyLatest, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-already-latest",
	})
	if err != nil || alreadyLatest.Replayed || alreadyLatest.Status != document.WikiRefreshAlreadyLatest ||
		alreadyLatest.WikiRevisionID != "wiki_revision_document_current" {
		t.Fatalf("already-latest refresh=%+v error=%v", alreadyLatest, err)
	}
	var afterNoChange int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refreshes`).Scan(&afterNoChange); err != nil {
		t.Fatal(err)
	}
	if afterNoChange != refreshCount {
		t.Fatalf("already_latest created refresh facts: before=%d after=%d", refreshCount, afterNoChange)
	}
}

func TestUnifiedDocumentWikiRefreshRetriesInvalidSourcesWithoutClaimingLatest(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("frozen Wiki source bytes")
	digest := sha256.Sum256(content)
	object, _, err := objects.PutIfAbsent(ctx,
		"object_dddddddddddddddddddddddddddddddd", bytes.NewReader(content),
		int64(len(content)), digest)
	if err != nil {
		t.Fatal(err)
	}
	seedWikiDispatchSource(t, ctx, db, object, digest)
	service := document.NewWithObjectStore(pool, objects)
	readyDocumentTexts(t, pool, objects, nil)
	accepted, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-invalid-first",
	})
	if err != nil || accepted.Status != document.WikiRefreshAccepted {
		t.Fatalf("accepted refresh=%+v error=%v", accepted, err)
	}
	dispatcher, err := document.NewWikiRefreshDispatcher(
		pool, objects, &recordingWikiCandidateGenerator{fail: document.ErrWikiCandidateInvalidRequest}, service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	delivered, deliverErr := deliverWikiAttempt(t, pool, dispatcher, accepted.ID)
	if !delivered || deliverErr != nil {
		t.Fatalf("delivered=%t error=%v", delivered, deliverErr)
	}
	var errorCode string
	if err := db.QueryRowContext(ctx, `SELECT coalesce(dispatch_last_error_code,'')
		FROM document_wiki_refreshes WHERE id=$1`, accepted.ID).Scan(&errorCode); err != nil {
		t.Fatal(err)
	}
	if errorCode != "candidate_invalid" {
		t.Fatalf("dispatch error code=%s", errorCode)
	}

	blocked, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-invalid-retry",
	})
	if err != nil || blocked.Status != document.WikiRefreshAccepted || blocked.ID == "" {
		t.Fatalf("blocked refresh=%+v error=%v", blocked, err)
	}
	var refreshCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refreshes`).Scan(&refreshCount); err != nil {
		t.Fatal(err)
	}
	if refreshCount != 2 {
		t.Fatalf("unchanged invalid sources created refresh facts: count=%d", refreshCount)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,
			base_version_id
		) VALUES(
			'version_wiki_invalid_source_v2','tenant_document_a','document_human_a',2,
			'source.md','markdown','text/markdown',1,repeat('2',64),
			'object_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','replacement_upload','actor_human_a',
			'version_wiki_dispatch_source'
		);
		UPDATE documents SET current_version_id='version_wiki_invalid_source_v2'
		WHERE id='document_human_a'
	`); err != nil {
		t.Fatal(err)
	}
	readyDocumentTexts(t, pool, objects, nil)
	retried, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-refresh-invalid-after-change",
	})
	if err != nil || retried.Status != document.WikiRefreshInProgress || retried.ID != blocked.ID {
		t.Fatalf("changed sources refresh=%+v error=%v", retried, err)
	}
}

func TestUnifiedDocumentEmptyWikiRefreshHasNoSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := document.New(pool)
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	input := document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-empty-refresh",
	}

	result, err := service.RequestWikiRefresh(ctx, input)
	if err != nil || result.Replayed || result.Status != document.WikiRefreshNoSources ||
		result.WikiID != "wiki_document_a" || result.ID != "" || result.WikiRevisionID != "" {
		t.Fatalf("empty Wiki refresh=%+v error=%v", result, err)
	}
	replayed, err := service.RequestWikiRefresh(ctx, input)
	if err != nil || !replayed.Replayed || replayed.Status != document.WikiRefreshNoSources ||
		replayed.WikiID != result.WikiID || replayed.ID != "" || replayed.WikiRevisionID != "" {
		t.Fatalf("empty Wiki refresh replay=%+v error=%v", replayed, err)
	}
	var refreshCount, keyCount int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id='wiki_document_a'),
		(SELECT count(*) FROM command_replays WHERE operation='document.wiki.refresh')
	`).Scan(&refreshCount, &keyCount); err != nil {
		t.Fatal(err)
	}
	if refreshCount != 0 || keyCount != 1 {
		t.Fatalf("empty already_latest side effects refreshes=%d keys=%d", refreshCount, keyCount)
	}
}

func TestUnifiedDocumentNativeWikiSourceUsesRevisionSnapshot(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := wikiSourceExportService(t, pool, "revision")
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_human_a','actor_human_a'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_unversioned_source','tenant_document_a','document_human_a',
			'wiki_source','wiki_document_a','active'
		)
	`); err != nil {
		t.Fatal(err)
	}

	readyDocumentTexts(t, pool, nil, service)
	input := document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-unversioned-source-refresh",
	}
	result, err := service.RequestWikiRefresh(ctx, input)
	if err != nil || result.Replayed || result.Status != document.WikiRefreshAccepted ||
		result.WikiID != "wiki_document_a" || result.ID == "" || result.WikiRevisionID != "" {
		t.Fatalf("unversioned Wiki source refresh=%+v error=%v", result, err)
	}
	var refreshCount, versionedSources, boundSources int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id='wiki_document_a'),
		(SELECT count(*) FROM document_context_bindings binding
		 JOIN documents document ON document.id=binding.document_id
		  AND document.tenant_id=binding.tenant_id
		 WHERE binding.wiki_id='wiki_document_a' AND binding.binding_kind='wiki_source'
		   AND binding.status='active' AND document.current_version_id IS NOT NULL),
		(SELECT count(*) FROM document_context_bindings
		 WHERE wiki_id='wiki_document_a' AND binding_kind='wiki_source' AND status='active')
	`).Scan(&refreshCount, &versionedSources, &boundSources); err != nil {
		t.Fatal(err)
	}
	if refreshCount != 1 || versionedSources != 0 || boundSources != 1 {
		t.Fatalf("unversioned already_latest side effects refreshes=%d versioned=%d bound=%d",
			refreshCount, versionedSources, boundSources)
	}
}

func TestUnifiedDocumentUnversionedWikiSourceDoesNotBlockVersionedRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := document.New(pool)
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_wiki_versioned_source','tenant_document_a','notes.txt','plain_text',
			'actor_human_a','human','actor_human_a','human','active'
		);
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_versioned_source','tenant_document_a','document_wiki_versioned_source',
			1,'notes.txt','plain_text','text/plain',12,repeat('b',64),
			'object_wiki_versioned_source','ordinary_upload','actor_human_a'
		);
		UPDATE documents SET current_version_id='version_wiki_versioned_source'
		WHERE id='document_wiki_versioned_source';
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES
			('binding_wiki_unversioned_source','tenant_document_a','document_human_a',
			 'wiki_source','wiki_document_a','active'),
			('binding_wiki_versioned_source','tenant_document_a','document_wiki_versioned_source',
			 'wiki_source','wiki_document_a','active')
	`); err != nil {
		t.Fatal(err)
	}

	readyDocumentTexts(t, pool, nil, nil)
	result, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-mixed-source-refresh",
	})
	if err != nil || result.Replayed || result.Status != document.WikiRefreshAccepted ||
		result.WikiID != "wiki_document_a" || result.ID == "" || addedWikiSources(t, db, result.ID) != 1 {
		t.Fatalf("mixed Wiki source refresh=%+v error=%v", result, err)
	}
	var frozenSources int
	var frozenVersionID string
	if err := db.QueryRowContext(ctx, `SELECT count(*),min(frozen_document_version_id)
		FROM document_wiki_refresh_sources WHERE refresh_id=$1`, result.ID).Scan(
		&frozenSources, &frozenVersionID); err != nil {
		t.Fatal(err)
	}
	if frozenSources != 1 || frozenVersionID != "version_wiki_versioned_source" {
		t.Fatalf("frozen sources=%d version=%s", frozenSources, frozenVersionID)
	}
}

func TestUnifiedDocumentBlankWikiBindDoesNotAdmitEmptySourceRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	service := wikiSourceExportService(t, pool, "\n")
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_wiki_blank_page','tenant_document_a','nba study','blocknote',
			'actor_human_a','human','actor_human_a','human','active'
		);
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES(
			'revision_wiki_blank_page','tenant_document_a','document_wiki_blank_page',0,'\x00',
			repeat('c',64),'\x00','6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
			'[]'::jsonb,'actor_human_a'
		);
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_wiki_blank_page','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_wiki_blank_page','actor_human_a'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id
	`); err != nil {
		t.Fatal(err)
	}

	bound, err := service.BindToPersonalWiki(ctx, document.BindDocumentToPersonalWikiInput{
		AccountID: "account_document_a", DocumentID: "document_wiki_blank_page",
		TenantID: "tenant_document_a",
	})
	if err != nil || bound.Document.CurrentVersion != nil ||
		!hasUnifiedDocumentSource(bound.Document, "wiki_source", "wiki_document_a") {
		t.Fatalf("blank Wiki bind=%+v error=%v", bound, err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_blank_newline','tenant_document_a','document_wiki_blank_page',1,
			'untitled.md','markdown','text/markdown',1,
			'01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
			'object_wiki_blank_newline','ordinary_upload','actor_human_a'
		);
		UPDATE documents SET current_version_id='version_wiki_blank_newline'
		WHERE id='document_wiki_blank_page'
	`); err != nil {
		t.Fatal(err)
	}
	result, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "blank-wiki-newline-refresh",
	})
	if err != nil || result.Status != document.WikiRefreshNoSources || result.ID != "" {
		t.Fatalf("empty Wiki version refresh=%+v error=%v", result, err)
	}
}

func TestUnifiedDocumentDraftTitleUsesExactHeadWithoutCreatingPageHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_human_a','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES('document_ordinary_title','tenant_document_a','ordinary.txt','plain_text',
			'actor_human_a','human','actor_human_a','human','active')
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)
	input := document.UpdateDraftTitleInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		Title: "Canonical Draft Title",
	}
	result, err := service.UpdateDraftTitle(ctx, input)
	if err != nil || !result.Changed || result.Document.Title != input.Title {
		t.Fatalf("UpdateDraftTitle result=%+v error=%v", result, err)
	}

	// The title lives in documents.title alone: the body and its Revisions
	// stay as they were.
	assertTitleSideEffects := func(label string) {
		t.Helper()
		var title string
		var seq int64
		var revisions, history, titleEvents int
		if err := db.QueryRowContext(ctx, `SELECT document.title,body.seq,
			(SELECT count(*) FROM document_revisions WHERE document_id=document.id),
			(SELECT count(*) FROM document_revisions WHERE document_id=document.id AND history_trigger IS NOT NULL),
			(SELECT count(*) FROM document_events WHERE document_id=document.id AND event_type='document.title_updated')
			FROM documents document JOIN document_bodies body ON body.document_id=document.id
			WHERE document.id='document_human_a'`).Scan(&title, &seq, &revisions, &history, &titleEvents); err != nil {
			t.Fatal(err)
		}
		if title != input.Title || seq != 0 || revisions != 1 || history != 0 || titleEvents != 1 {
			t.Fatalf("%s title=%q seq=%d revisions=%d history=%d events=%d",
				label, title, seq, revisions, history, titleEvents)
		}
	}
	assertTitleSideEffects("title commit")
	// A repeated rename finds the title already set.
	noChange, err := service.UpdateDraftTitle(ctx, input)
	if err != nil || noChange.Changed || noChange.Document.Title != input.Title {
		t.Fatalf("UpdateDraftTitle repeat=%+v error=%v", noChange, err)
	}
	for name, invalid := range map[string]document.UpdateDraftTitleInput{
		"ordinary Document": {
			AccountID: "account_document_a", DocumentID: "document_ordinary_title",
			Title: "Must not commit",
		},
	} {
		if _, updateErr := service.UpdateDraftTitle(ctx, invalid); !errors.Is(updateErr, document.ErrNotFound) {
			t.Fatalf("%s error=%v want not found", name, updateErr)
		}
	}
	assertTitleSideEffects("after refused titles")
}

func TestUnifiedDocumentDraftTitlePublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, "draft-title-http-create")
	if status != http.StatusCreated {
		t.Fatalf("create native Document status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	path := "/v0/documents/" + created.ID + "/draft-title"
	request := map[string]any{"title": "HTTP Native Title"}
	for _, attempt := range []string{"update", "repeat"} {
		status, _, body := env.request(alice, http.MethodPatch, path, request, "")
		if status != http.StatusOK || !strings.Contains(string(body), `"title":"HTTP Native Title"`) {
			t.Fatalf("%s Draft title status=%d body=%s", attempt, status, body)
		}
	}
}

func TestUnifiedDocumentTypedBindingPublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	roomID := env.createRoom(alice, acmeTenant, "Typed Binding Room", "typed-binding-room")

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, "typed-binding-document")
	if status != http.StatusCreated {
		t.Fatalf("create Document status=%d body=%s", status, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	decode(t, body, &created)
	if created.ID == "" {
		t.Fatalf("created Document has no identity: %s", body)
	}
	if _, err := env.pool.Exec(context.Background(), `
		INSERT INTO work_items(
			id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
		) VALUES('work_item_typed_binding','tenant_acme',99001,'issue','Typed Binding Task',
			'actor_acme_alice','actor_acme_alice');
		INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES('wiki_typed_binding','tenant_acme','actor_acme_alice')
	`); err != nil {
		t.Fatal(err)
	}

	commands := []struct {
		path, key, kind, contextID string
	}{
		{"/v0/rooms/" + roomID + "/documents/" + created.ID, "typed-bind-http-room", "room", roomID},
		{"/v0/work-items/work_item_typed_binding/documents/" + created.ID, "typed-bind-http-task", "task", "work_item_typed_binding"},
		{"/v0/tenants/tenant_acme/personal-wiki/documents/" + created.ID, "typed-bind-http-wiki", "wiki_source", "wiki_typed_binding"},
	}
	for _, command := range commands {
		status, headers, response := env.request(alice, http.MethodPut, command.path, nil, command.key)
		if status != http.StatusOK || headers.Get("Idempotent-Replay") != "" ||
			!strings.Contains(string(response), `"id":"`+created.ID+`"`) ||
			!strings.Contains(string(response), `"binding_kind":"`+command.kind+`"`) ||
			!strings.Contains(string(response), `"context_id":"`+command.contextID+`"`) {
			t.Fatalf("typed bind %s status=%d replay=%q body=%s", command.kind, status,
				headers.Get("Idempotent-Replay"), response)
		}
		// A Work Item binding replays its key; a Room or Wiki binding finds
		// itself active and changes nothing.
		status, headers, repeated := env.request(alice, http.MethodPut, command.path, nil, command.key)
		if status != http.StatusOK || (headers.Get("Idempotent-Replay") == "true") != (command.kind == "task") ||
			!strings.Contains(string(repeated), `"binding_kind":"`+command.kind+`"`) {
			t.Fatalf("repeated typed bind %s status=%d replay=%q body=%s", command.kind,
				status, headers.Get("Idempotent-Replay"), repeated)
		}
	}
}

func TestUnifiedDocumentDuplicateClonesNativeRevisionAndOrdinaryVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objectRoot := t.TempDir()
	objects, err := artifactstore.NewLocalStore(objectRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceObject, err := objects.Put(ctx, bytes.NewReader([]byte("asset source bytes")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO accounts(id,email,password_hash)
		VALUES('account_document_reader','document-reader@example.com','x');
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
		VALUES('actor_human_reader','tenant_document_a','human','Human Reader','account_document_reader');
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES('room_document_a','tenant_document_a','actor_human_reader','member','actor_human_a');
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status
		) VALUES('binding_duplicate_reader','tenant_document_a','document_human_a','room',
			'room_document_a','active');
		UPDATE documents SET title='Native source' WHERE id='document_human_a';
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES('document_existing_duplicate_name','tenant_document_a','Native source copy','blocknote',
			'actor_human_reader','human','actor_human_reader','human','active');
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,name,sort_key
		) VALUES('placement_duplicate_target','tenant_document_a','personal','actor_human_reader',
			'folder','Release notes','release-notes');
		INSERT INTO document_placements(
			id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,parent_id,sort_key
		) VALUES('placement_existing_duplicate_name','tenant_document_a','personal','actor_human_reader',
			'document','document_existing_duplicate_name','placement_duplicate_target','existing-copy');
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_human_a','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES
			('document_ordinary_source','tenant_document_a','source.txt','plain_text',
			 'actor_human_a','human','actor_human_a','human','active'),
			('document_missing_source','tenant_document_a','Missing Draft','blocknote',
			 'actor_human_a','human','actor_human_a','human','active'),
			('document_referenced_source','tenant_document_a','Referenced Draft','blocknote',
			 'actor_human_a','human','actor_human_a','human','active');
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES('version_ordinary_source','tenant_document_a','document_ordinary_source',1,
			'source.txt','plain_text','text/plain',12,repeat('d',64),'object_ordinary_source',
			'ordinary_upload','actor_human_a');
		UPDATE documents SET current_version_id='version_ordinary_source'
		WHERE id='document_ordinary_source';
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
		) VALUES('revision_referenced_source','tenant_document_a','document_referenced_source',0,
			'\x01',repeat('e',64),'\x01','4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
			'[{"asset_id":"asset_source","sha256":"957fef8358466c7671681881d4738b61fc03242c4103d45107f70e9cb52239f2","size_bytes":18}]'::jsonb,
			ARRAY['thread_source'],'actor_human_a');
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_referenced_source','tenant_document_a',0,'\x01',repeat('e',64),
			'revision_referenced_source','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_assets(
		id,tenant_id,document_id,filename,media_type,sha256,size_bytes,content_object_id,status
	) VALUES('asset_source','tenant_document_a','document_referenced_source','source.bin',
		'application/octet-stream',$1,$2,$3,'available')`,
		hex.EncodeToString(sourceObject.SHA256[:]), sourceObject.Size, sourceObject.Key); err != nil {
		t.Fatal(err)
	}
	duplicateRuntime := func(
		_ context.Context, input document.ImportRequest,
	) (document.ImportedState, error) {
		return document.ImportedState{
			StateBytes: []byte{2}, StateBytesSHA256: "dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
			StateVector: []byte{3}, FullStateFingerprint: "dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
			StateHashVersion: 1, CompleteAssetIDs: []string{input.AssetMappings[0].TargetAssetID},
			CompleteThreadIDs: []string{},
		}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: duplicateRuntime}, objects)

	targetFolderID := "placement_duplicate_target"
	nativeInput := document.DuplicateDocumentInput{
		AccountID: "account_document_reader", DocumentID: "document_human_a",
		TargetFolderID: &targetFolderID,
	}
	native, err := service.Duplicate(ctx, nativeInput)
	if err != nil || native.Document.ID == "" ||
		native.Document.Title != "Native source copy 2" ||
		native.Document.Owner.ID != "actor_human_reader" ||
		native.Document.Creator.ID != "actor_human_reader" || native.Document.CurrentVersion != nil ||
		native.Document.DraftCapability != "write" {
		t.Fatalf("native Duplicate=%+v error=%v", native, err)
	}
	// A repeated Duplicate makes another copy.
	again, err := service.Duplicate(ctx, nativeInput)
	if err != nil || again.Document.ID == "" || again.Document.ID == native.Document.ID {
		t.Fatalf("repeated native Duplicate=%+v error=%v", again, err)
	}

	ordinary, err := service.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_ordinary_source",
	})
	if err != nil || ordinary.Document.ID == "" ||
		ordinary.Document.ID == "document_ordinary_source" || ordinary.Document.CurrentVersion == nil ||
		ordinary.Document.CurrentVersion.VersionNumber != 1 ||
		ordinary.Document.CurrentVersion.SHA256 != strings.Repeat("d", 64) {
		t.Fatalf("ordinary Duplicate=%+v error=%v", ordinary, err)
	}
	referenced, err := service.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_referenced_source",
	})
	if err != nil || referenced.Document.ID == "" {
		t.Fatalf("referenced Duplicate=%+v error=%v", referenced, err)
	}
	beforeFailures, err := os.ReadDir(objectRoot)
	if err != nil {
		t.Fatal(err)
	}
	failingRuntime := document.NewWithRuntime(pool, documentRuntimeStub{importer: func(
		context.Context, document.ImportRequest,
	) (document.ImportedState, error) {
		return document.ImportedState{}, errors.New("runtime unavailable")
	}}, objects)
	if _, err := failingRuntime.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_referenced_source",
	}); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("Duplicate Runtime failure error=%v", err)
	}
	invalidRuntime := document.NewWithRuntime(pool, documentRuntimeStub{importer: func(
		_ context.Context, input document.ImportRequest,
	) (document.ImportedState, error) {
		return document.ImportedState{
			StateBytes:       []byte{9},
			StateBytesSHA256: strings.Repeat("0", 64), StateVector: []byte{1},
			FullStateFingerprint: strings.Repeat("0", 64), StateHashVersion: 1,
			CompleteAssetIDs: []string{input.AssetMappings[0].TargetAssetID},
		}, nil
	}}, objects)
	if _, err := invalidRuntime.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_referenced_source",
	}); !errors.Is(err, document.ErrRevisionUnavailable) {
		t.Fatalf("Duplicate invalid Runtime result error=%v", err)
	}
	afterFailures, err := os.ReadDir(objectRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterFailures) != len(beforeFailures) {
		t.Fatalf("failed Duplicate leaked objects before=%d after=%d", len(beforeFailures), len(afterFailures))
	}
	if err := objects.Delete(ctx, sourceObject.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Duplicate(ctx, document.DuplicateDocumentInput{
		AccountID: "account_document_a", DocumentID: "document_referenced_source",
	}); !errors.Is(err, document.ErrObjectStoreUnavailable) {
		t.Fatalf("Duplicate missing source object error=%v", err)
	}

	for name, input := range map[string]document.DuplicateDocumentInput{
		"missing content": {
			AccountID: "account_document_a", DocumentID: "document_missing_source",
		},
	} {
		_, duplicateErr := service.Duplicate(ctx, input)
		if name == "missing content" && !errors.Is(duplicateErr, document.ErrRevisionUnavailable) {
			t.Fatalf("%s error=%v want Revision unavailable", name, duplicateErr)
		}
	}

	var nativeBytes, sourceBytes []byte
	var ordinaryObjectID string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT state_bytes FROM document_revisions WHERE document_id=$1),
		(SELECT state_bytes FROM document_revisions WHERE id='revision_human_a'),
		(SELECT content_object_id FROM document_versions WHERE document_id=$2)
	`, native.Document.ID, ordinary.Document.ID).Scan(
		&nativeBytes, &sourceBytes, &ordinaryObjectID,
	); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(nativeBytes, sourceBytes) || ordinaryObjectID != "object_ordinary_source" {
		t.Fatalf("Duplicate lineage bytes_equal=%t object=%s",
			bytes.Equal(nativeBytes, sourceBytes), ordinaryObjectID)
	}
	var resultDocuments, resultPlacements, failedKeys, targetAssets int
	var resultBindings, resultComments, resultHistory, resultVersions int
	var nativeParentID string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM documents WHERE id IN ($1,$2,$3)),
		(SELECT count(*) FROM document_placements WHERE document_id IN ($1,$2,$3)),
		(SELECT count(*) FROM command_replays WHERE operation='document.duplicate'
		 AND key IN ('duplicate-no-access','duplicate-missing-content',
		 'duplicate-runtime-failure','duplicate-invalid-runtime-result','duplicate-missing-source-object')),
		(SELECT count(*) FROM document_assets WHERE document_id=$3 AND id<>'asset_source'),
		(SELECT parent_id FROM document_placements WHERE document_id=$1),
		(SELECT count(*) FROM document_context_bindings WHERE document_id IN ($1,$2,$3)),
		(SELECT count(*) FROM room_document_comment_threads WHERE document_id IN ($1,$2,$3)),
		(SELECT count(*) FROM document_revisions WHERE document_id IN ($1,$2,$3) AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM document_versions WHERE document_id IN ($1,$2,$3))
	`, native.Document.ID, ordinary.Document.ID, referenced.Document.ID).Scan(
		&resultDocuments, &resultPlacements, &failedKeys, &targetAssets,
		&nativeParentID, &resultBindings, &resultComments, &resultHistory, &resultVersions,
	); err != nil {
		t.Fatal(err)
	}
	if resultDocuments != 3 || resultPlacements != 3 || failedKeys != 0 ||
		targetAssets != 1 || nativeParentID != targetFolderID || resultBindings != 0 ||
		resultComments != 0 || resultHistory != 0 || resultVersions != 1 {
		t.Fatalf("Duplicate side effects documents=%d placements=%d failed_keys=%d assets=%d parent=%q bindings=%d comments=%d history=%d versions=%d",
			resultDocuments, resultPlacements, failedKeys, targetAssets, nativeParentID,
			resultBindings, resultComments, resultHistory, resultVersions)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1
		WHERE id='binding_duplicate_reader' AND status='active'`); err != nil {
		t.Fatal(err)
	}
	if copied, err := service.Get(ctx, "account_document_reader", native.Document.ID); err != nil ||
		copied.ID != native.Document.ID {
		t.Fatalf("Duplicate depended on revoked source access copy=%+v error=%v", copied, err)
	}
}

func TestUnifiedDocumentDuplicatePublicHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	status, _, sourceBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{
		"representation_format": "html",
	}, "duplicate-http-source")
	if status != http.StatusCreated {
		t.Fatalf("create Duplicate source status=%d body=%s", status, sourceBody)
	}
	var source struct {
		ID string `json:"id"`
	}
	decode(t, sourceBody, &source)
	status, _, folderBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/me/document-folders",
		map[string]any{"name": "References"}, "duplicate-http-folder")
	if status != http.StatusCreated {
		t.Fatalf("create target Folder status=%d body=%s", status, folderBody)
	}
	var folder struct {
		ID string `json:"id"`
	}
	decode(t, folderBody, &folder)

	path := "/v0/documents/" + source.ID + "/duplicates"
	request := map[string]any{"target_folder_id": folder.ID}
	status, _, body := env.request(alice, http.MethodPost, path, request, "")
	if status != http.StatusCreated {
		t.Fatalf("Duplicate status=%d body=%s", status, body)
	}
	var duplicate struct {
		ID                   string `json:"id"`
		Title                string `json:"title"`
		RepresentationFormat string `json:"representation_format"`
		DraftCapability      string `json:"draft_capability"`
		CurrentVersion       any    `json:"current_version"`
		Owner                struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"owner"`
		From []any `json:"from"`
	}
	decode(t, body, &duplicate)
	if duplicate.ID == "" || duplicate.ID == source.ID || duplicate.Title != "untitled copy" ||
		duplicate.RepresentationFormat != "html" || duplicate.DraftCapability != "write" ||
		duplicate.CurrentVersion != nil || duplicate.Owner.ID != "actor_acme_alice" ||
		duplicate.Owner.Kind != "human" || len(duplicate.From) != 0 {
		t.Fatalf("Duplicate response=%+v body=%s", duplicate, body)
	}
	status, _, treeBody := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/me/document-tree", nil, "")
	if status != http.StatusOK || !strings.Contains(string(treeBody), `"document_id":"`+duplicate.ID+`"`) ||
		!strings.Contains(string(treeBody), `"parent_id":"`+folder.ID+`"`) {
		t.Fatalf("Duplicate target tree status=%d body=%s", status, treeBody)
	}
	// A repeated Duplicate makes another copy.
	status, _, again := env.request(alice, http.MethodPost, path, request, "")
	if status != http.StatusCreated || strings.Contains(string(again), `"id":"`+duplicate.ID+`"`) {
		t.Fatalf("repeated Duplicate status=%d body=%s", status, again)
	}
}

func newUnifiedDocumentActionsFixture(t *testing.T) (*sql.DB, *pgxpool.Pool) {
	t.Helper()
	return newUnifiedDocumentFixture(t, `
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
			('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a')
	`)
}

func hasUnifiedDocumentSource(value document.Document, kind, contextID string) bool {
	for _, source := range value.From {
		if source.BindingKind == kind && source.ContextID == contextID {
			return true
		}
	}
	return false
}
