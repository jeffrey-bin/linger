package integration_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentLinkShareLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	owner := document.LinkSharePrincipal{AccountID: "account_document_a"}
	input := document.SetLinkShareInput{Principal: owner, DocumentID: "document_human_a", Role: "viewer"}
	created, err := service.SetLinkShare(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Token == "" || created.Version != 1 {
		t.Fatalf("missing link capability or version")
	}
	digest := sha256.Sum256([]byte(created.Token))
	var matches bool
	if err := db.QueryRowContext(ctx, `SELECT link_share_token_sha256=$1 FROM documents WHERE link_share_id=$2`, digest[:], created.ID).Scan(&matches); err != nil || !matches {
		t.Fatalf("digest stored=%v error=%v", matches, err)
	}
	access, err := service.ResolveLinkShare(ctx, created.Token)
	if err != nil || access.Role != "viewer" || access.DocumentID != input.DocumentID {
		t.Fatalf("access=%+v error=%v", access, err)
	}

	input.Role, input.ExpectedVersion = "editor", 1
	updated, err := service.SetLinkShare(ctx, input)
	if err != nil || updated.Token != "" || updated.Version != 2 {
		t.Fatalf("updated=%+v error=%v", updated, err)
	}
	access, err = service.ResolveLinkShare(ctx, created.Token)
	if err != nil || access.Role != "editor" {
		t.Fatalf("access=%+v error=%v", access, err)
	}
	if _, err := service.SetLinkShare(ctx, input); !errors.Is(err, document.ErrConflict) {
		t.Fatalf("stale update error=%v", err)
	}

	input.ExpectedVersion, input.Reset = 2, true
	reset, err := service.SetLinkShare(ctx, input)
	if err != nil || reset.Token == "" || reset.Token == created.Token {
		t.Fatalf("reset error=%v", err)
	}
	if _, err := service.ResolveLinkShare(ctx, created.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("old link after reset error=%v", err)
	}
	if err := service.RevokeLinkShare(ctx, document.RevokeLinkShareInput{Principal: owner, DocumentID: input.DocumentID, ExpectedVersion: reset.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveLinkShare(ctx, reset.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("revoked link error=%v", err)
	}
	var documentEvents int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_events WHERE document_id=$1 AND event_type='document.link_share.updated' AND resource_kind='link_share' AND resource_id=$2`, input.DocumentID, created.ID).Scan(&documentEvents); err != nil || documentEvents != 4 {
		t.Fatalf("documentEvents=%d error=%v", documentEvents, err)
	}
}

func TestUnifiedDocumentLinkShareManagementAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	input := document.SetLinkShareInput{Principal: document.LinkSharePrincipal{AgentID: "agent_document_a"}, DocumentID: "document_human_a", Role: "viewer"}
	// The Agent manages the link as its Human does, even through a viewer Binding.
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings SET role='viewer',access_epoch=access_epoch+1,updated_at=clock_timestamp() WHERE id='binding_semantic_apply'`); err != nil {
		t.Fatal(err)
	}
	link, err := service.SetLinkShare(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedVersion = link.Version
	if err := service.Trash(ctx, document.TrashDocumentInput{AccountID: "account_document_a", DocumentID: "document_human_a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveLinkShare(ctx, link.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("trashed document link error=%v", err)
	}
	var linkStatus string
	var linkVersion int
	if err := db.QueryRowContext(ctx, `SELECT link_share_status,link_share_version FROM documents WHERE link_share_id=$1`, link.ID).Scan(&linkStatus, &linkVersion); err != nil || linkStatus != "revoked" || linkVersion != int(link.Version)+1 {
		t.Fatalf("trash must durably revoke link: status=%s version=%d error=%v", linkStatus, linkVersion, err)
	}
}
