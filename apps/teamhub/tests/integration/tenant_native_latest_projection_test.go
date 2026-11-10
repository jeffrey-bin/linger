package integration_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestNativeLatestProjectionCoalescesConcurrentConsumers(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	var calls atomic.Int32
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	documents := document.NewWithRuntime(pool, documentRuntimeStub{export: func(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
			return document.ExportRuntimeResult{}, ctx.Err()
		}
		content := []byte("shared native revision")
		return document.ExportRuntimeResult{
			MediaType: "text/markdown", Bytes: content,
			SizeBytes: int64(len(content)), SHA256: semanticDigest(content),
			CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{},
		}, nil
	}}, objects)
	results := make(chan error, 4)
	for range 4 {
		go func() {
			projection, err := documents.LatestDocumentRuntimeProjection(t.Context(), "document_human_a")
			if err == nil && string(projection.Bytes) != "shared native revision" {
				err = errors.New("consumer received a different native revision")
			}
			results <- err
		}()
	}
	select {
	case <-entered:
	case <-time.After(30 * time.Second):
		close(release)
		t.Fatal("native computation did not start")
	}
	// Give all consumers time to reach the same deliberately blocked compute.
	select {
	case <-time.After(200 * time.Millisecond):
	case <-t.Context().Done():
	}
	close(release)
	for range 4 {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("four consumers computed the same frozen revision %d times; want once", got)
	}
	t.Run("one canceled consumer preserves remaining compute", func(t *testing.T) {
		if _, err := pool.Exec(t.Context(), `DELETE FROM document_latest_projections WHERE document_id='document_human_a' AND representation_format='markdown'`); err != nil {
			t.Fatal(err)
		}
		entered := make(chan struct{}, 2)
		release := make(chan struct{})
		var computations atomic.Int32
		service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
			computations.Add(1)
			entered <- struct{}{}
			select {
			case <-release:
			case <-ctx.Done():
				return document.ExportRuntimeResult{}, ctx.Err()
			}
			content := []byte("surviving consumer")
			return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
		}}, objects)
		firstCtx, cancel := context.WithCancel(t.Context())
		defer cancel()
		first := make(chan error, 1)
		second := make(chan error, 1)
		go func() { _, err := service.LatestDocumentRuntimeProjection(firstCtx, "document_human_a"); first <- err }()
		select {
		case <-entered:
		case <-time.After(30 * time.Second):
			close(release)
			t.Fatal("compute did not start")
		}
		go func() {
			projection, err := service.LatestDocumentRuntimeProjection(t.Context(), "document_human_a")
			if err == nil && string(projection.Bytes) != "surviving consumer" {
				err = errors.New("wrong surviving result")
			}
			second <- err
		}()
		time.Sleep(200 * time.Millisecond)
		cancel()
		if err := <-first; !errors.Is(err, context.Canceled) {
			close(release)
			t.Fatalf("canceled consumer: %v", err)
		}
		close(release)
		if err := <-second; err != nil {
			t.Fatal(err)
		}
		if computations.Load() != 1 {
			t.Fatalf("cancellation triggered duplicate compute: %d", computations.Load())
		}
	})
	t.Run("all canceled consumers allow retry", func(t *testing.T) {
		if _, err := pool.Exec(t.Context(), `DELETE FROM document_latest_projections WHERE document_id='document_human_a' AND representation_format='markdown'`); err != nil {
			t.Fatal(err)
		}
		entered, canceled := make(chan struct{}), make(chan struct{})
		var computations atomic.Int32
		service := document.NewWithRuntime(pool, documentRuntimeStub{export: func(ctx context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
			if computations.Add(1) == 1 {
				close(entered)
				<-ctx.Done()
				close(canceled)
				return document.ExportRuntimeResult{}, ctx.Err()
			}
			content := []byte("retry result")
			return document.ExportRuntimeResult{MediaType: "text/markdown", Bytes: content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content), CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{}}, nil
		}}, objects)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		result := make(chan error, 1)
		go func() { _, err := service.LatestDocumentRuntimeProjection(ctx, "document_human_a"); result <- err }()
		select {
		case <-entered:
		case <-time.After(30 * time.Second):
			t.Fatal("compute did not start")
		}
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled consumer: %v", err)
		}
		select {
		case <-canceled:
		case <-time.After(30 * time.Second):
			t.Fatal("abandoned compute not canceled")
		}
		projection, err := service.LatestDocumentRuntimeProjection(t.Context(), "document_human_a")
		if err != nil || string(projection.Bytes) != "retry result" || computations.Load() != 2 {
			t.Fatalf("retry result=%q calls=%d error=%v", projection.Bytes, computations.Load(), err)
		}
	})
}

func TestLatestReadRetriesSettlementSerializationFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	if _, err := pool.Exec(t.Context(), `
		CREATE SEQUENCE latest_settle_retry_test_seq;
		CREATE FUNCTION reject_latest_settle_once() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF nextval('latest_settle_retry_test_seq') = 1 THEN
				RAISE EXCEPTION 'latest settle serialization test' USING ERRCODE='40001';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER reject_latest_settle_once
			BEFORE INSERT OR UPDATE ON document_latest_projections
			FOR EACH ROW EXECUTE FUNCTION reject_latest_settle_once()`); err != nil {
		t.Fatal(err)
	}
	runtimeCalls := 0
	documents := document.NewWithRuntime(pool, documentRuntimeStub{export: func(
		_ context.Context,
		input document.ExportRuntimeRequest,
	) (document.ExportRuntimeResult, error) {
		runtimeCalls++
		content := []byte("# settle retry\n")
		return document.ExportRuntimeResult{
			MediaType: "text/markdown",
			Bytes:     content, SizeBytes: int64(len(content)), SHA256: semanticDigest(content),
			CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}, Warnings: []string{},
		}, nil
	}}, objects)
	if _, err := documents.LatestDocumentRuntimeProjection(t.Context(), "document_human_a"); err != nil {
		t.Fatal(err)
	}
	var attempts int64
	if err := pool.QueryRow(t.Context(), `SELECT last_value FROM latest_settle_retry_test_seq`).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("settle attempts=%d want=2 (one 40001 then success)", attempts)
	}
	var settled int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM document_latest_projections
		WHERE tenant_id='tenant_document_a' AND document_id='document_human_a'
		  AND revision_id='revision_semantic_base' AND representation_format='markdown'`).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if settled != 1 || runtimeCalls != 1 {
		t.Fatalf("settled=%d runtime_calls=%d want settled=1 runtime_calls=1", settled, runtimeCalls)
	}
}
