package integration_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

func TestLatestOnDemandReadersRecheckRevisionAndAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, reader := range []string{"owner", "share", "agent"} {
		for _, scenario := range []string{"current", "new_revision", "revoked", "continual_revision"} {
			if reader == "owner" && scenario == "revoked" {
				// The single Human reads every active Document; links lose
				// access when revoked and Agents when they are removed.
				continue
			}
			t.Run(reader+"/"+scenario, func(t *testing.T) {
				db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
				var calls atomic.Int32
				service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
					call := calls.Add(1)
					if scenario == "continual_revision" {
						_, err := db.ExecContext(ctx, `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
 SELECT $1,tenant_id,document_id,$2,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id FROM document_revisions WHERE id='revision_semantic_base'`, fmt.Sprintf("revision_read_%d", call), int64(call)+1)
						if err == nil {
							_, err = pool.Exec(ctx, `UPDATE document_bodies SET seq=$2,state=(SELECT state_bytes FROM document_revisions WHERE id=$1),state_vector=(SELECT state_vector FROM document_revisions WHERE id=$1) WHERE document_id='document_human_a'`, fmt.Sprintf("revision_read_%d", call), int64(call)+1)
						}
						if err != nil {
							return document.ExportRuntimeResult{}, err
						}
					}
					if call == 1 {
						switch scenario {
						case "new_revision":
							_, err := db.ExecContext(ctx, `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
        SELECT 'revision_read_new',tenant_id,document_id,2,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id FROM document_revisions WHERE id='revision_semantic_base';
        UPDATE document_bodies SET seq=2,state=(SELECT state_bytes FROM document_revisions WHERE id='revision_read_new'),state_vector=(SELECT state_vector FROM document_revisions WHERE id='revision_read_new') WHERE document_id='document_human_a'`)
							if err != nil {
								return document.ExportRuntimeResult{}, err
							}
						case "revoked":
							query := `UPDATE documents SET link_share_status='revoked' WHERE id='document_human_a' AND link_share_id IS NOT NULL`
							if reader == "agent" {
								query = `UPDATE agent_registrations SET status='revoked' WHERE agent_management_id='agent_document_a'`
							}
							if _, err := db.ExecContext(ctx, query); err != nil {
								return document.ExportRuntimeResult{}, err
							}
						}
					}
					content := []byte(input.RevisionID)
					return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
				}}, objects)
				var link document.LinkShare
				var err error
				if reader == "share" {
					link, err = service.SetLinkShare(t.Context(), document.SetLinkShareInput{Principal: document.LinkSharePrincipal{AccountID: "account_document_a"}, DocumentID: "document_human_a", Role: "viewer"})
					if err != nil {
						t.Fatal(err)
					}
				}
				var key string
				if reader == "owner" {
					content, readErr := service.GetLatestDownloadContent(t.Context(), document.LatestDownloadInput{AccountID: "account_document_a", DocumentID: "document_human_a"})
					err = readErr
					key = content.ObjectKey
				} else if reader == "agent" {
					content, readErr := service.DownloadAgentFileAs(t.Context(), "tenant_document_a", "agent_document_a", "document_human_a", "markdown")
					err, key = readErr, content.ObjectKey
				} else {
					content, readErr := service.DownloadLinkFile(t.Context(), link.Token)
					err = readErr
					key = content.ObjectKey
				}
				if scenario == "continual_revision" {
					if !errors.Is(err, document.ErrLatestProjectionNotReady) || key != "" || calls.Load() != 3 {
						t.Fatalf("unstable latest key=%q calls=%d error=%v", key, calls.Load(), err)
					}
					return
				}
				if scenario == "revoked" {
					if !errors.Is(err, document.ErrNotFound) || key != "" {
						t.Fatalf("revoked read key=%s error=%v", key, err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				want := "revision_semantic_base"
				wantCalls := int32(1)
				if scenario == "new_revision" {
					want = "revision_read_new"
					wantCalls = 2
				}
				object, err := objects.Open(t.Context(), key)
				if err != nil {
					t.Fatal(err)
				}
				contents, err := io.ReadAll(object)
				_ = object.Close()
				if err != nil || string(contents) != want || calls.Load() != wantCalls {
					t.Fatalf("contents=%q calls=%d error=%v", contents, calls.Load(), err)
				}
			})
		}
	}
}

func TestLatestOnDemandReadersShareOneCompute(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	var calls atomic.Int32
	entered, release := make(chan struct{}, 3), make(chan struct{})
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return document.ExportRuntimeResult{}, ctx.Err()
		}
		content := []byte("shared read")
		return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
	}}, objects)
	if _, err := service.CreateDirectCollaborator(t.Context(), document.CreateDirectCollaboratorInput{AccountID: "account_document_a", DocumentID: "document_human_a", TargetActorID: "actor_agent_a", Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	link, err := service.SetLinkShare(t.Context(), document.SetLinkShareInput{Principal: document.LinkSharePrincipal{AccountID: "account_document_a"}, DocumentID: "document_human_a", Role: "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 3)
	go func() {
		_, err := service.GetLatestDownloadContent(t.Context(), document.LatestDownloadInput{AccountID: "account_document_a", DocumentID: "document_human_a"})
		results <- err
	}()
	go func() { _, err := service.DownloadLinkFile(t.Context(), link.Token); results <- err }()
	go func() {
		_, err := service.DownloadAgentFileAs(t.Context(), "tenant_document_a", "agent_document_a", "document_human_a", "markdown")
		results <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("render did not start")
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	for range 3 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("three readers computed %d times", calls.Load())
	}
}

func TestLatestProjectionGCBacksOffUploadAndRetainsReaderGrace(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	blocker := &latestUploadBarrierStore{ObjectStore: objects, entered: make(chan string, 1), release: make(chan struct{})}
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(_ context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		content := []byte(input.RevisionID)
		return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
	}}, blocker)
	startDocumentJobsForTest(t, pool, service, nil)
	done := make(chan error, 1)
	go func() {
		_, err := service.LatestDocumentRuntimeProjection(t.Context(), "document_human_a")
		done <- err
	}()
	var key string
	select {
	case key = <-blocker.entered:
	case <-time.After(5 * time.Second):
		close(blocker.release)
		t.Fatal("upload did not start")
	}
	// Make the cleanup due while the upload still holds the object lock. The
	// job must snooze instead of waiting for the upload.
	if _, err := pool.Exec(t.Context(), `UPDATE river_job SET state='available',scheduled_at=clock_timestamp()-interval '1 second'
		WHERE kind='document.latest_projection_object_cleanup' AND args->>'object_key'=$1`, key); err != nil {
		close(blocker.release)
		t.Fatal(err)
	}
	// River v0.49 keeps a snooze no longer than its scheduler interval in
	// state 'available' with a future scheduled_at, so match the snooze count
	// and the future time rather than a particular state.
	if !waitForLatestProjectionJob(t, pool, key, `state IN ('available','scheduled') AND scheduled_at>clock_timestamp()
		AND coalesce((metadata->>'snoozes')::int,0)>=1`) {
		close(blocker.release)
		t.Fatal("busy object cleanup was not snoozed")
	}
	// Restore the grace period; the job must stay queued until it passes.
	setLatestProjectionJobDue(t, pool, key, "5 minutes", false)
	close(blocker.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
  SELECT 'revision_gc_new',tenant_id,document_id,2,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id FROM document_revisions WHERE id='revision_semantic_base';
  UPDATE document_bodies SET seq=2,state=(SELECT state_bytes FROM document_revisions WHERE id='revision_gc_new'),state_vector=(SELECT state_vector FROM document_revisions WHERE id='revision_gc_new') WHERE document_id='document_human_a'`); err != nil {
		t.Fatal(err)
	}
	oldReader, err := objects.Open(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer oldReader.Close()
	if _, err := service.LatestDocumentRuntimeProjection(t.Context(), "document_human_a"); err != nil {
		t.Fatal(err)
	}
	// The replaced object is still inside its reader grace period.
	if _, err := objects.Head(t.Context(), key); err != nil {
		t.Fatalf("old object removed inside grace: %v", err)
	}
	oldContent, err := io.ReadAll(oldReader)
	if err != nil || string(oldContent) != "revision_semantic_base" {
		t.Fatalf("reader lost old object: %q %v", oldContent, err)
	}
	setLatestProjectionJobDue(t, pool, key, "-1 second", true)
	if !waitForLatestProjectionObjectRemoved(t, objects, key) {
		t.Fatal("expired detached object retained")
	}
	var referenced int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM document_latest_projections WHERE document_id='document_human_a' AND representation_format='markdown'`).Scan(&referenced); err != nil || referenced != 1 {
		t.Fatalf("current projection lost: %d %v", referenced, err)
	}
}

// startDocumentJobsForTest runs TeamHub's Document River processor so cleanup
// and Wiki graph jobs execute as they do in TeamHub. Pass a nil updater when the
// test does not need the Memory graph.
func startDocumentJobsForTest(t *testing.T, pool *pgxpool.Pool, service *document.Service, updater document.PublishedWikiGraphUpdater) {
	t.Helper()
	client, err := newDocumentJobClient(pool, service, updater)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(ctx)
	})
}

// newDocumentJobClient builds TeamHub's job client with only the Document
// workers, so tests run Document jobs without the app's periodic sweeps.
func newDocumentJobClient(pool *pgxpool.Pool, service *document.Service, updater document.PublishedWikiGraphUpdater) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	document.AddJobWorkers(workers, service, updater)
	return jobs.NewClient(pool, jobs.Options{Workers: workers, PollInterval: riverTestPollInterval, TestOnly: true})
}

// drainDocumentJobs processes jobs registered by document.AddJobWorkers until
// none remain queued or running, then stops the processor. It works in HTTP handlers,
// where t.Fatal is not.
func drainDocumentJobs(ctx context.Context, pool *pgxpool.Pool, service *document.Service, updater document.PublishedWikiGraphUpdater) error {
	client, err := newDocumentJobClient(pool, service, updater)
	if err != nil {
		return err
	}
	if err := client.Start(context.Background()); err != nil {
		return err
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	}()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var pending int
		// Wait only for AddJobWorkers registrations. Wiki dispatch is driven
		// explicitly; native import jobs require a separate Runtime worker.
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job
			WHERE kind IN ('document.latest_projection_object_cleanup','document.personal_wiki_graph_update','document.wiki_refresh_followup')
			  AND state IN ('available','pending','retryable','running','scheduled')`).Scan(&pending); err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("Document jobs did not drain")
}

// setLatestProjectionJobDue moves the cleanup job for key. Making it due sets
// it available so River fetches it; otherwise it waits in the scheduled state.
func setLatestProjectionJobDue(t *testing.T, pool *pgxpool.Pool, key, offset string, due bool) {
	t.Helper()
	state := "scheduled"
	if due {
		state = "available"
	}
	if _, err := pool.Exec(t.Context(), `UPDATE river_job SET state=$2,scheduled_at=clock_timestamp()+$3::interval
		WHERE kind='document.latest_projection_object_cleanup' AND args->>'object_key'=$1
		  AND state IN ('available','scheduled','retryable')`, key, state, offset); err != nil {
		t.Fatal(err)
	}
}

func waitForLatestProjectionJob(t *testing.T, pool *pgxpool.Pool, key, condition string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var matched bool
		if err := pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM river_job
			WHERE kind='document.latest_projection_object_cleanup' AND args->>'object_key'=$1 AND `+condition+`)`, key).Scan(&matched); err != nil {
			t.Fatal(err)
		}
		if matched {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func waitForLatestProjectionObjectRemoved(t *testing.T, objects artifactstore.ObjectStore, key string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := objects.Head(t.Context(), key); errors.Is(err, os.ErrNotExist) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

type latestUploadBarrierStore struct {
	artifactstore.ObjectStore
	entered chan string
	release chan struct{}
	calls   atomic.Int32
}

func (s *latestUploadBarrierStore) PutIfAbsent(ctx context.Context, key string, reader io.Reader, size int64, digest [32]byte) (artifactstore.Object, bool, error) {
	if s.calls.Add(1) == 1 {
		s.entered <- key
		select {
		case <-s.release:
		case <-ctx.Done():
			return artifactstore.Object{}, false, ctx.Err()
		}
	}
	return s.ObjectStore.PutIfAbsent(ctx, key, reader, size, digest)
}
