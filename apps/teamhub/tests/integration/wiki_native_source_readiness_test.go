package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// Serial: conversion and admission overlap against PostgreSQL. Each entry point
// owns one database; pure polling/deadline permutations live in document units.
func TestWikiNativeImportReadyBeforeSingleGeneration(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, memory := range []bool{false, true} {
		t.Run(fmt.Sprintf("memory=%t", memory), func(t *testing.T) {
			ctx := t.Context()
			objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
			if err != nil {
				t.Fatal(err)
			}
			transient := []byte("# Temporary upload\n")
			digest := sha256.Sum256(transient)
			object, _, err := objects.PutIfAbsent(ctx, "object_"+hex.EncodeToString(digest[:16]), bytes.NewReader(transient), int64(len(transient)), digest)
			if err != nil {
				t.Fatal(err)
			}
			// Admission reads persisted source heads, not the Upload protocol.
			db, pool := newUnifiedWikiFixture(t, `
				UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
				WHERE actor_id='actor_agent_a';
				INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
				VALUES('document_import_source','tenant_document_a','attachment.md','markdown','actor_human_a','human','actor_human_a','human','active');
				INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,
					size_bytes,sha256,content_object_id,source,created_by_actor_id)
				VALUES('version_import_transient','tenant_document_a','document_import_source',1,'attachment.md','markdown','text/markdown',
					$1,$2,$3,'ordinary_upload','actor_human_a');
				UPDATE documents SET current_version_id='version_import_transient' WHERE id='document_import_source';
				INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status)
				VALUES('binding_import_source','tenant_document_a','document_import_source','wiki_source','wiki_document_a','active');
				UPDATE documents SET native_import_status='failed',native_import_source_version_id='version_import_transient'
				WHERE id='document_import_source';`,
				object.Size, hex.EncodeToString(object.SHA256[:]), object.Key)
			const id = "document_import_source"
			exporter := func(_ context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
				content := []byte("# Stable attachment\n")
				digest := sha256.Sum256(content)
				return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: hex.EncodeToString(digest[:]), CompleteAssetIDs: append([]string{}, input.CompleteAssetIDs...), CompleteThreadIDs: append([]string{}, input.CompleteThreadIDs...), Warnings: []string{}}, nil
			}
			service := document.NewWithRuntime(pool, documentRuntimeStub{export: exporter}, objects)
			// Memory's refresh intent is scoped by its night, so each Memory
			// request names its own night.
			nights := map[string]string{
				"native-failed": "2026-11-01", "native-cancelled": "2026-11-02", "native-completed": "2026-11-03",
			}
			request := func(callctx context.Context, requestService *document.Service, key string) (document.WikiRefreshResult, error) {
				if memory {
					result, err := requestService.RequestMemoryWikiRefresh(callctx, document.RequestMemoryWikiRefreshInput{
						TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: nights[key],
					})
					return result.Refresh, err
				}
				return requestService.RequestWikiRefresh(callctx, document.RequestWikiRefreshInput{AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key})
			}

			t.Run("failed source is excluded", func(t *testing.T) {
				setNativeWikiImportState(t, db, id, "failed")
				result, err := request(t.Context(), service, "native-failed")
				if err != nil || result.Status != document.WikiRefreshNoSources {
					t.Fatalf("failed import admission=%+v error=%v", result, err)
				}
				assertNoWikiRefresh(t, db)
			})
			if !memory {
				t.Run("stuck source is excluded after the default bound", func(t *testing.T) {
					setNativeWikiImportState(t, db, id, "pending")
					withVirtualWikiImportRequest(t, pool.Config(), exporter, objects, func(t *testing.T, requestService *document.Service, requestDB *sql.DB) {
						callctx, cancel := context.WithTimeout(t.Context(), 6*time.Second)
						defer cancel()
						virtualStarted := time.Now()
						result, err := request(callctx, requestService, "native-stuck")
						if err != nil || result.Status != document.WikiRefreshNoSources || time.Since(virtualStarted) != 5*time.Second {
							t.Fatalf("stuck import admission=%+v error=%v elapsed=%s", result, err, time.Since(virtualStarted))
						}
						assertNoWikiRefresh(t, requestDB)
					})
				})
			}

			type outcome struct {
				refresh document.WikiRefreshResult
				err     error
			}
			t.Run("cancellation cannot partially admit", func(t *testing.T) {
				setNativeWikiImportState(t, db, id, "pending")
				withVirtualWikiImportRequest(t, pool.Config(), exporter, objects, func(t *testing.T, requestService *document.Service, requestDB *sql.DB) {
					callctx, cancel := context.WithCancel(t.Context())
					defer cancel()
					finished := make(chan outcome, 1)
					go func() {
						refresh, err := request(callctx, requestService, "native-cancelled")
						finished <- outcome{refresh, err}
					}()
					synctest.Wait()
					select {
					case result := <-finished:
						t.Fatalf("admitted pending upload before cancellation: %+v", result)
					default:
					}
					assertNoWikiRefresh(t, requestDB)
					cancel()
					result := <-finished
					if !errors.Is(result.err, context.Canceled) || result.refresh.ID != "" {
						t.Fatalf("cancelled import admission=%+v error=%v", result.refresh, result.err)
					}
					assertNoWikiRefresh(t, requestDB)
				})
			})

			completionName := "pending and running wait for committed native revision"
			if !memory {
				completionName = "completed representation generates exactly once"
			}
			t.Run(completionName, func(t *testing.T) {
				// Every filtered scenario prepares its own initial import state.
				// Fresh keys and zero refresh/source rows prevent shared state from
				// replaying or masking a previous outcome.
				setNativeWikiImportState(t, db, id, "pending")
				assertNoWikiRefresh(t, db)
				var result outcome
				withVirtualWikiImportRequest(t, pool.Config(), exporter, objects, func(t *testing.T, requestService *document.Service, requestDB *sql.DB) {
					finished := make(chan outcome, 1)
					callctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
					defer cancel()
					go func() {
						refresh, err := request(callctx, requestService, "native-completed")
						finished <- outcome{refresh, err}
					}()
					synctest.Wait()
					select {
					case result := <-finished:
						t.Fatalf("admitted pending upload: %+v", result)
					default:
					}
					assertNoWikiRefresh(t, requestDB)
					setNativeWikiImportState(t, requestDB, id, "pending")
					time.Sleep(100 * time.Millisecond)
					synctest.Wait()
					select {
					case result := <-finished:
						t.Fatalf("admitted running upload: %+v", result)
					default:
					}
					assertNoWikiRefresh(t, requestDB)
					completeNativeWikiImport(t, requestDB, id)
					result = <-finished
				})
				if result.err != nil || result.refresh.Status != document.WikiRefreshAccepted {
					t.Fatalf("ready source admission=%+v", result)
				}
				admission := result.refresh
				var revision string
				if err := db.QueryRowContext(ctx, `SELECT revision.id FROM document_wiki_refresh_sources source
					JOIN document_revisions revision ON revision.document_id=source.document_id
					 AND document_text_version_id(source.document_id,'native_body',revision.persisted_seq::text)=source.frozen_document_version_id
					WHERE source.refresh_id=$1 AND source.document_id=$2`, admission.ID, id).Scan(&revision); err != nil {
					t.Fatal(err)
				}
				if revision != "revision_import_ready" {
					t.Fatalf("froze temporary upload instead of current native revision: %q", revision)
				}
				// Keep public completion and generation in the same selectable
				// scenario. Memory's serializable admission has its own boundary;
				// one public path owns generation, settlement and replay.
				if memory {
					return
				}
				generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}}}}
				dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
				if err != nil {
					t.Fatal(err)
				}
				if worked, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); err != nil || !worked {
					t.Fatalf("generation worked=%v error=%v", worked, err)
				}
				if worked, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); err != nil || worked {
					t.Fatalf("unexpected conversion followup worked=%v error=%v", worked, err)
				}
				again, err := request(ctx, service, "native-unchanged")
				if err != nil || again.Status != document.WikiRefreshAlreadyLatest {
					t.Fatalf("unchanged content queued again: %+v %v", again, err)
				}
				var refreshes, followups int
				if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM document_wiki_refreshes),
					(SELECT count(*) FROM river_job WHERE kind='document.wiki_refresh_followup' AND state IN ('available','pending','retryable','running','scheduled'))`).Scan(&refreshes, &followups); err != nil {
					t.Fatal(err)
				}
				if refreshes != 1 || followups != 0 || len(generator.callsSnapshot()) != 1 {
					t.Fatalf("representation-only generation duplicated: refreshes=%d followups=%d calls=%d", refreshes, followups, len(generator.callsSnapshot()))
				}
			})
		})
	}
}

// Only immutable configuration and committed PostgreSQL state cross the bubble.
// pgconn owns timers, so clients opened here must close here and never return a
// connection to a pool or sql.DB that later runs on the real clock.
func withVirtualWikiImportRequest(
	t *testing.T,
	config *pgxpool.Config,
	exporter func(context.Context, document.ExportRuntimeRequest) (document.ExportRuntimeResult, error),
	objects artifactstore.ObjectStore,
	run func(*testing.T, *document.Service, *sql.DB),
) {
	t.Helper()
	synctest.Test(t, func(t *testing.T) {
		requestPool, err := pgxpool.NewWithConfig(t.Context(), config)
		if err != nil {
			t.Fatal(err)
		}
		defer requestPool.Close()
		requestDB := stdlib.OpenDB(*config.ConnConfig)
		defer func() { _ = requestDB.Close() }()
		requestService := document.NewWithRuntime(requestPool, documentRuntimeStub{export: exporter}, objects)
		run(t, requestService, requestDB)
	})
}

func assertNoWikiRefresh(t *testing.T, db *sql.DB) {
	t.Helper()
	var refreshes, sources int
	if err := db.QueryRowContext(t.Context(), `SELECT
		(SELECT count(*) FROM document_wiki_refreshes),
		(SELECT count(*) FROM document_wiki_refresh_sources)`).Scan(&refreshes, &sources); err != nil {
		t.Fatal(err)
	}
	if refreshes != 0 || sources != 0 {
		t.Fatalf("native import not ready but queued %d refreshes with %d frozen sources", refreshes, sources)
	}
}

// setNativeWikiImportState sets the readiness state the scenario needs. The
// import state machine forbids reopening a finished import, so this fixture
// helper bypasses the guard for one statement instead of modelling a real
// transition.
func setNativeWikiImportState(t *testing.T, db *sql.DB, id, importStatus string) {
	t.Helper()
	ctx := t.Context()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `SET LOCAL session_replication_role=replica`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE documents SET native_import_status=$2 WHERE id=$1`, id, importStatus); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func completeNativeWikiImport(t *testing.T, db *sql.DB, id string) {
	t.Helper()
	ctx := t.Context()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id) SELECT 'revision_import_ready',tenant_id,$1,0,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id FROM document_revisions WHERE id='revision_human_a'`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE documents SET format='blocknote',current_version_id=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ($1,'tenant_document_a',0,'\x00',repeat('c',64),'revision_import_ready','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `UPDATE documents SET native_import_status='completed' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	// The text sync the new body queued finishes with the import, so a
	// waiting admission reads the completed source.
	if _, err = tx.ExecContext(ctx, `INSERT INTO document_texts(
			document_id,tenant_id,source_kind,source_id,status,markdown,markdown_sha256,search_text
		) VALUES($1,'tenant_document_a','native_body','0','ready','# Stable attachment
',encode(sha256(convert_to('# Stable attachment
','UTF8')),'hex'),'Stable attachment')
		ON CONFLICT (document_id) DO UPDATE SET source_kind=EXCLUDED.source_kind,source_id=EXCLUDED.source_id,
			status=EXCLUDED.status,markdown=EXCLUDED.markdown,markdown_sha256=EXCLUDED.markdown_sha256,
			search_text=EXCLUDED.search_text`, id); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
