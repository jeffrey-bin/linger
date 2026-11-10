package integration_test

import (
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentCLIConditionalDownloadChecksAuthorityAndVersion(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithRuntime(pool, nil, objects)
	const tenantID, agentID, documentID = "tenant_document_a", "agent_document_a", "document_agent_conditional"
	firstVersionID := seedAgentTaskFile(t, pool, objects, documentID, "large.bin", "binary", "application/octet-stream", []byte("first"))
	downloaded, err := service.DownloadAgentFileConditional(t.Context(), tenantID, agentID, documentID, "markdown", "")
	if err != nil {
		t.Fatal(err)
	}
	tag := downloaded.CacheTag()
	// A verified cache does not require storage to remain reachable.
	if err := objects.Delete(t.Context(), downloaded.ObjectKey); err != nil {
		t.Fatal(err)
	}
	cached, err := service.DownloadAgentFileConditional(t.Context(), tenantID, agentID, documentID, "markdown", tag)
	if err != nil || !cached.NotModified {
		t.Fatalf("cached=%+v err=%v", cached, err)
	}
	if _, err := service.DownloadAgentFileConditional(t.Context(), tenantID, "unknown-agent", documentID, "markdown", tag); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("unauthorized cached request=%v", err)
	}
	secondVersionID := seedAgentFileVersion(t, pool, objects, documentID, firstVersionID, "large.bin", "binary", "application/octet-stream", []byte("second"))
	updated, err := service.DownloadAgentFileConditional(t.Context(), tenantID, agentID, documentID, "markdown", tag)
	if err != nil || updated.NotModified || updated.VersionID != secondVersionID {
		t.Fatalf("updated=%+v err=%v", updated, err)
	}
}
