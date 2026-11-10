package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// An Agent edits every Document its Human does, whoever owns it and whether or
// not it was ever shared; only a Wiki page, which only settlement writes,
// stays read-only.
func TestAgentEditsEveryDocumentItsHumanEdits(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	linkUnifiedDocumentTaskOriginRoom(t, ctx, db)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	for _, scenario := range []string{"owner", "human", "shared_then_revoked", "wiki_page"} {
		t.Run(scenario, func(t *testing.T) {
			documentID := "document_native_" + scenario
			input := semanticMutationInput(principal, "semantic-actor-access-"+scenario)
			input.DocumentID, input.TargetID = documentID, documentID
			ownerActorID, ownerActorKind := "actor_human_a", "human"
			if scenario == "owner" {
				ownerActorID, ownerActorKind = "actor_agent_a", "agent"
			}
			// Every case owns its Document, draft, revision, grants and commands;
			// the seed revision is immutable and is never a mutation target.
			_, seedErr := pool.Exec(ctx, `
 INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
 VALUES($1,'tenant_document_a','Actor access document','blocknote',$2,$3,$2,$3,'active');
 INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id)
 SELECT $4,tenant_id,$1,persisted_seq,state_vector,full_state_fingerprint,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
 FROM document_revisions WHERE id='revision_semantic_base';
 INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids)
 SELECT $1,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids
 FROM document_bodies WHERE document_id='document_human_a'`, pgx.QueryExecModeSimpleProtocol,
				documentID, ownerActorID, ownerActorKind, "revision_native_"+scenario)
			if seedErr != nil {
				t.Fatal(seedErr)
			}
			runtimeCalls := 0
			service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
			switch scenario {
			case "shared_then_revoked":
				// A share asks the Agent to look and grants nothing, so ending it
				// takes nothing away either.
				if _, err := db.ExecContext(ctx, `INSERT INTO document_direct_collaborators(
 id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version,revoked_at)
 VALUES('share_revoked_'||$1,'tenant_document_a',$1,'actor_agent_a','viewer','revoked','actor_human_a',2,clock_timestamp())`, documentID); err != nil {
					t.Fatal(err)
				}
			case "wiki_page":
				if _, err := db.ExecContext(ctx, `INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
 VALUES('wiki_actor_access','tenant_document_a','actor_human_a') ON CONFLICT DO NOTHING`); err != nil {
					t.Fatal(err)
				}
				if _, err := db.ExecContext(ctx, `INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status,role)
 SELECT 'binding_wiki_page_'||$1,'tenant_document_a',$1,'wiki_page',wiki.id,'active','viewer'
 FROM personal_wikis wiki WHERE wiki.tenant_id='tenant_document_a' AND wiki.owner_actor_id='actor_human_a'
 ORDER BY wiki.id LIMIT 1`, documentID); err != nil {
					t.Fatal(err)
				}
			}
			result, err := service.ApplySemanticMutation(ctx, input)
			allowed := scenario != "wiki_page"
			if allowed {
				if err != nil || result.Status != document.SemanticMutationApplied || result.RevisionID == "" || result.HistoryEntryID == "" {
					t.Fatalf("authorized native edit=%+v error=%v", result, err)
				}
				replay, err := service.ApplySemanticMutation(ctx, input)
				if err != nil || !replay.Replayed || replay.RevisionID != result.RevisionID {
					t.Fatalf("native edit replay=%+v error=%v", replay, err)
				}
			} else if !errors.Is(err, document.ErrNotFound) {
				t.Fatalf("unauthorized native edit=%+v error=%v", result, err)
			}
			wantCalls := 0
			if allowed {
				wantCalls = 1
			}
			if runtimeCalls != wantCalls {
				t.Fatalf("runtime calls=%d want %d", runtimeCalls, wantCalls)
			}
			var seq, histories, versions, bindings, agentContributions int
			if err := db.QueryRowContext(ctx, `SELECT
				 (SELECT seq FROM document_bodies WHERE document_id=$1),
				 (SELECT count(*) FROM document_revisions WHERE document_id=$1 AND history_trigger IS NOT NULL),
				 (SELECT count(*) FROM document_versions WHERE document_id=$1),
				 (SELECT count(*) FROM document_context_bindings WHERE document_id=$1),
				 (SELECT count(*) FROM document_revisions
				  WHERE document_id=$1 AND 'actor_agent_a'=ANY(history_contributor_ids))
				`, documentID).Scan(&seq, &histories, &versions, &bindings, &agentContributions); err != nil {
				t.Fatal(err)
			}
			wantSeq, wantHistories, wantBindings := 1, 0, 1
			if allowed {
				wantSeq, wantHistories, wantBindings = 2, 1, 0
			}
			if seq != wantSeq || histories != wantHistories || agentContributions != wantHistories || versions != 0 || bindings != wantBindings {
				t.Fatalf("native evidence seq=%d histories=%d agent=%d versions=%d bindings=%d", seq, histories, agentContributions, versions, bindings)
			}
		})
	}
}
