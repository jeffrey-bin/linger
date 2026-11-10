package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestAgentCLIDocumentsUseBusinessAuthorityWithoutRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	ctx := t.Context()
	principal, err := agentcredential.Authenticate(ctx, env.pool, issued.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	materializer := func(context.Context, document.ImportRequest) (document.ImportedState, error) {
		state := []byte{7, 8, 9}
		return document.ImportedState{StateBytes: state, StateBytesSHA256: semanticDigest(state), StateVector: []byte{1}, FullStateFingerprint: semanticDigest(state), StateHashVersion: 1, CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}}, nil
	}
	creator := document.NewWithRuntime(env.pool, documentRuntimeStub{importer: materializer}, nil)
	input := document.CreateAgentDocumentInput{Principal: &principal, TargetKind: "room", TargetID: roomID, SourceInvocationID: "cli-create-stable-operation", Title: "CLI native document", Markdown: "# Created without Run\n"}
	created, err := creator.CreateAgentDocument(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := creator.CreateAgentDocument(ctx, input)
	if err != nil || !replay.Replayed || replay.DocumentID != created.DocumentID {
		t.Fatalf("create replay=%+v err=%v", replay, err)
	}
	changed := input
	changed.Title = "different"
	if _, err := creator.CreateAgentDocument(ctx, changed); !errors.Is(err, document.ErrIdempotencyConflict) {
		t.Fatalf("create different payload: %v", err)
	}
	calls := 0
	mutator := document.NewWithRuntime(env.pool, documentRuntimeStub{apply: semanticApply(env.pool, &calls)}, nil)
	mutation := document.ApplySemanticMutationInput{Principal: &principal, TargetKind: "document", TargetID: created.DocumentID, DocumentID: created.DocumentID, SourceInvocationID: "cli-edit-stable-operation", SchemaVersion: "blocknote-semantic-v1", SemanticChange: json.RawMessage(`[{"kind":"edit_document","parser_version":"markdown-v1","command":"set_title","title":"Agent title"}]`)}
	result, err := mutator.ApplySemanticMutation(ctx, mutation)
	if err != nil || result.Status != document.SemanticMutationApplied {
		t.Fatalf("mutation=%+v error=%v", result, err)
	}
	second, err := agentcredential.New(env.pool).IssueManaged(ctx, issued.AgentID, "rotated")
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := agentcredential.Authenticate(ctx, env.pool, second.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	mutation.Principal = &rotated
	result, err = mutator.ApplySemanticMutation(ctx, mutation)
	if err != nil || !result.Replayed || calls != 1 {
		t.Fatalf("rotated replay=%+v calls=%d err=%v", result, calls, err)
	}

	var sponsorAccount string
	if err := env.pool.QueryRow(ctx, `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&sponsorAccount); err != nil {
		t.Fatal(err)
	}

	authorizer := agentauth.New(env.pool)
	t.Run("thread target resolves its Document", func(t *testing.T) {
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
 VALUES('document_cli_foreign_thread',$1,'Private','blocknote','actor_acme_alice','human','actor_acme_alice','human','active')`, principal.TenantID); err != nil {
			t.Fatal(err)
		}
		for _, fixture := range []struct{ threadID, documentID string }{{"thread_cli_authorized", created.DocumentID}, {"thread_cli_foreign", "document_cli_foreign_thread"}} {
			if _, err := tx.Exec(ctx, `INSERT INTO room_document_comment_threads(id,tenant_id,document_id,current_anchor_id,anchor_status,created_by_actor_id,
 anchor_kind,anchor_quoted_text,anchor_block_id,anchor_context_before,anchor_context_after,anchor_version_number,anchor_created_by_actor_id)
 VALUES($1,$2,$3,$1||'_anchor','attached','actor_acme_alice','selection','Text','block_first','','',1,'actor_acme_alice')`, fixture.threadID, principal.TenantID, fixture.documentID); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		// The Agent has its Human's access, so a thread on the Human's private
		// Document resolves too; only a missing thread is refused.
		for _, tool := range []string{"get_document_comment_thread", "reply_document_comment", "replace_document_comment_text"} {
			for threadID, documentID := range map[string]string{"thread_cli_authorized": created.DocumentID, "thread_cli_foreign": "document_cli_foreign_thread"} {
				resolved, err := authorizer.Authorize(agentauth.WithTarget(ctx, "thread", threadID), issued.AccessToken, tool)
				if err != nil || resolved.DocumentID != documentID || resolved.Target.Kind != "document" {
					t.Fatalf("thread %s authority=%+v err=%v", threadID, resolved, err)
				}
			}
			if _, err := authorizer.Authorize(agentauth.WithTarget(ctx, "thread", "thread_cli_missing"), issued.AccessToken, tool); !errors.Is(err, agentauth.ErrForbidden) {
				t.Fatalf("missing thread tool=%s err=%v", tool, err)
			}
		}
	})
	if _, err := authorizer.Authorize(agentauth.WithTarget(ctx, "room", roomID), issued.AccessToken, "send_message_sequence"); !errors.Is(err, agentauth.ErrForbidden) {
		t.Fatalf("general gained AnotherMe-only tool: %v", err)
	}
	// Every meta Context may manage its Sponsor's Agents.
	if _, err := authorizer.Authorize(agentauth.WithTarget(ctx, "room", roomID), issued.AccessToken, "list_available_agents"); err != nil {
		t.Fatalf("general cannot list its Sponsor's Agents: %v", err)
	}
	var executionRows int
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM agent_local_runs`).Scan(&executionRows); err != nil || executionRows != 0 {
		t.Fatalf("execution prerequisites=%d err=%v", executionRows, err)
	}
	if err := revokeAgentCredential(ctx, env.pool, second.CredentialID); err != nil {
		t.Fatal(err)
	}
	mutation.SourceInvocationID = "cli-revoked-edit"
	if _, err := mutator.ApplySemanticMutation(ctx, mutation); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("revoked write=%v", err)
	}
}
