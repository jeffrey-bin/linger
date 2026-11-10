package integration_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentCLIReplacementChecksDownloadedBaseAndReplays(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, format := range []string{"html", "blocks"} {
		t.Run(format, func(t *testing.T) {
			db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
			beforeRevisions := 0
			if err := db.QueryRow(`SELECT count(*) FROM document_revisions WHERE document_id='document_human_a'`).Scan(&beforeRevisions); err != nil {
				t.Fatal(err)
			}
			calls := 0
			service := document.NewWithRuntime(pool, documentRuntimeStub{apply: applyToBody(pool, func(
				request document.ApplyRequest, _ []byte,
			) ([]byte, []byte, []string, []string, string, error) {
				calls++
				return []byte{4, 5, 6}, []byte{2}, nil, nil, request.Semantic.CurrentTitle, nil
			})}, objects)
			principal := issueAgentPrincipal(t, pool, "agent_document_a")
			input := document.ReplaceAgentDocumentBodyInput{Principal: principal, DocumentID: "document_human_a", BaseRevisionID: "stale-revision", OperationID: "replace-cli-one", Format: format}
			apply := func() (document.ReplaceAgentDocumentBodyResult, error) {
				content := "<p>" + strings.Repeat("€✓", 60000) + "</p>"
				if format == "blocks" {
					content = `{"schema_version":1,"blocks":[{"id":"body","type":"paragraph","content":"` + strings.Repeat("€✓", 60000) + `"}]}`
				}
				input.Content = bytes.NewBufferString(content)
				return service.ReplaceAgentDocumentBody(t.Context(), input)
			}
			if _, err := apply(); !errors.Is(err, document.ErrVersionConflict) || calls != 0 {
				t.Fatalf("stale base calls=%d err=%v", calls, err)
			}
			input.BaseRevisionID = "revision_semantic_base"
			first, err := apply()
			if err != nil {
				t.Fatal(err)
			}
			replay, err := apply()
			if err != nil || !replay.Replayed || replay.RevisionID != first.RevisionID || replay.HistoryEntryID != first.HistoryEntryID || calls != 1 {
				t.Fatalf("replay=%+v calls=%d err=%v", replay, calls, err)
			}
			input.OperationID = "replace-cli-two"
			if _, err := apply(); !errors.Is(err, document.ErrVersionConflict) || calls != 1 {
				t.Fatalf("old download overwrote newer revision: %v", err)
			}
			input.BaseRevisionID = first.RevisionID
			input.OperationID = "replace-cli-expired"
			if _, err := db.Exec(`UPDATE agent_access_credentials SET expires_at=clock_timestamp() WHERE id=$1`, principal.CredentialID); err != nil {
				t.Fatal(err)
			}
			if _, err := apply(); !errors.Is(err, document.ErrNotFound) {
				t.Fatalf("expired authority: %v", err)
			}
			var revisions, histories, versions int
			if err := db.QueryRow(`SELECT (SELECT count(*) FROM document_revisions WHERE document_id='document_human_a'),(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),(SELECT count(*) FROM document_versions WHERE document_id='document_human_a')`).Scan(&revisions, &histories, &versions); err != nil {
				t.Fatal(err)
			}
			if revisions != beforeRevisions+1 || histories != 1 || versions != 0 {
				t.Fatalf("revisions=%d histories=%d versions=%d", revisions, histories, versions)
			}
		})
	}
}

// An edit saved after the download makes the replacement stale; the Runtime
// refuses it without saving.
func TestUnifiedDocumentCLIReplacementRejectsAnEditSavedAfterTheDownload(t *testing.T) {
	allowParallelIntegrationTest(t)
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	competingCalls := 0
	competing := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &competingCalls)}, objects)
	replaced := applyToBody(pool, func(document.ApplyRequest, []byte) ([]byte, []byte, []string, []string, string, error) {
		t.Fatal("a stale replacement was computed")
		return nil, nil, nil, nil, "", nil
	})
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: func(
		ctx context.Context, input document.ApplyRequest,
	) (document.ApplyResult, error) {
		if _, err := competing.ApplySemanticMutation(ctx, semanticMutationInput(principal, "competing-edit")); err != nil {
			return document.ApplyResult{}, err
		}
		return replaced(ctx, input)
	}}, objects)
	_, err := service.ReplaceAgentDocumentBody(t.Context(), document.ReplaceAgentDocumentBodyInput{Principal: principal, DocumentID: "document_human_a", BaseRevisionID: "revision_semantic_base", OperationID: "replace-cli-race", Content: bytes.NewBufferString("<p>fixture</p>")})
	if !errors.Is(err, document.ErrVersionConflict) || competingCalls != 1 {
		t.Fatalf("stale replacement calls=%d error=%v", competingCalls, err)
	}
}
