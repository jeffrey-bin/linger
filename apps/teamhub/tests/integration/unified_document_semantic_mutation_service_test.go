package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"
)

func TestUnifiedDocumentSemanticMutationAppliesAndReplaysAtomically(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
	input := semanticMutationInput(issueAgentPrincipal(t, pool, "agent_document_a"), "invocation-semantic-apply")
	result, err := service.ApplySemanticMutation(ctx, input)
	if err != nil || result.Status != document.SemanticMutationApplied || result.Replayed || runtimeCalls != 1 {
		t.Fatalf("semantic result=%+v calls=%d error=%v", result, runtimeCalls, err)
	}
	var title, historyTrigger string
	var seq, histories, titleEvents, historyEvents, contributors, replays int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT title FROM documents WHERE id='document_human_a'),
		(SELECT seq FROM document_bodies WHERE document_id='document_human_a'),
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT history_trigger FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a'
		 AND event_type='document.title_updated'),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a'
		 AND event_type='document.history_checkpointed'),
		(SELECT coalesce(sum(cardinality(history_contributor_ids)),0) FROM document_revisions
		 WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM command_replays WHERE key='invocation-semantic-apply')
	`).Scan(&title, &seq, &histories, &historyTrigger, &titleEvents, &historyEvents,
		&contributors, &replays); err != nil {
		t.Fatal(err)
	}
	if title != "Agent title" || seq != 2 || histories != 1 || historyTrigger != "agent_edit" ||
		titleEvents != 1 || historyEvents != 0 || contributors < 1 || replays != 1 {
		t.Fatalf("semantic evidence title=%q seq=%d histories=%d trigger=%s events=%d/%d contributors=%d replays=%d",
			title, seq, histories, historyTrigger, titleEvents, historyEvents, contributors, replays)
	}
	replayed, err := service.ApplySemanticMutation(ctx, input)
	if err != nil || !replayed.Replayed || replayed.Status != document.SemanticMutationApplied ||
		replayed.RevisionID != result.RevisionID || replayed.HistoryEntryID != result.HistoryEntryID || runtimeCalls != 1 {
		t.Fatalf("semantic replay=%+v calls=%d error=%v", replayed, runtimeCalls, err)
	}
	conflicting := input
	conflicting.SemanticChange = json.RawMessage(`[{"kind":"set_title","title":"Different"}]`)
	if _, err := service.ApplySemanticMutation(ctx, conflicting); !errors.Is(err, document.ErrIdempotencyConflict) {
		t.Fatalf("same invocation different request error=%v", err)
	}
}

// A Human save on the body an Agent change replaced is refused, and the same
// edits saved on the Agent's sequence apply.
func TestUnifiedDocumentHumanSaveRebasesOnAnAgentChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	calls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &calls)}, objects)
	credential, err := service.IssueCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	authorID := documentfixture.ConnectionTokenClaims(t, credential.CollaborationCredential).ActorID
	agent, err := service.ApplySemanticMutation(ctx, semanticMutationInput(
		issueAgentPrincipal(t, pool, "agent_document_a"), "invocation-debounce-window"))
	if err != nil || agent.Status != document.SemanticMutationApplied {
		t.Fatalf("Agent change=%+v error=%v", agent, err)
	}
	humanSave := func(basePersistedSeq int64, state []byte) (int64, bool) {
		seq, saved, err := saveDocumentBody(ctx, pool, documentBodySave{
			DocumentID: "document_human_a", BaseSeq: basePersistedSeq, State: state,
			StateVector: []byte{3}, EditorIDs: []string{authorID},
		})
		if err != nil {
			t.Fatal(err)
		}
		return seq, saved
	}
	if _, saved := humanSave(1, []byte{1, 2, 3, 7}); saved {
		t.Fatal("a Human save on the base the Agent change replaced was applied")
	}
	if seq, saved := humanSave(2, []byte{4, 5, 6, 7}); !saved || seq != 3 {
		t.Fatalf("rebased Human save seq=%d saved=%t", seq, saved)
	}
	var lastActorID string
	if err := db.QueryRowContext(ctx, `SELECT last_editor_ids[cardinality(last_editor_ids)]
		FROM document_bodies WHERE document_id='document_human_a'`).Scan(&lastActorID); err != nil {
		t.Fatal(err)
	}
	if lastActorID != "actor_human_a" {
		t.Fatalf("last editor=%s", lastActorID)
	}
}

func TestUnifiedDocumentRoomSemanticMutationOutlivesItsBindings(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	insertUnifiedDocumentRoomSemanticMutationBinding(t, ctx, db)
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
	input := semanticMutationInput(issueAgentPrincipal(t, pool, "agent_document_a"), "invocation-room-semantic-apply")
	input.SemanticChange = json.RawMessage(`[{"kind":"set_title","title":"Room Agent title"}]`)
	result, err := service.ApplySemanticMutation(ctx, input)
	if err != nil || result.Status != document.SemanticMutationApplied || runtimeCalls != 1 {
		t.Fatalf("Room semantic mutation result=%+v calls=%d error=%v", result, runtimeCalls, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id='binding_room_semantic_apply'`); err != nil {
		t.Fatal(err)
	}
	// Explicit Document ID access can still use the Actor's independent Task
	// binding after the Room binding is suspended.
	throughTask := input
	throughTask.SourceInvocationID = "invocation-room-semantic-task-access"
	if applied, err := service.ApplySemanticMutation(ctx, throughTask); err != nil ||
		applied.Status != document.SemanticMutationApplied || applied.RevisionID == "" || runtimeCalls != 2 {
		t.Fatalf("Room write through current Task access=%+v calls=%d error=%v", applied, runtimeCalls, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id='binding_semantic_apply'`); err != nil {
		t.Fatal(err)
	}
	// With no Binding left the Agent still writes with its Human's access.
	unbound := input
	unbound.SourceInvocationID = "invocation-room-semantic-unbound"
	if applied, err := service.ApplySemanticMutation(ctx, unbound); err != nil ||
		applied.Status != document.SemanticMutationApplied || runtimeCalls != 3 {
		t.Fatalf("Room semantic mutation without Bindings=%+v calls=%d error=%v", applied, runtimeCalls, err)
	}
}

// A viewer Task Binding does not cap an Agent that has its Human's access.
func TestUnifiedDocumentAlterEgoSemanticMutationWritesThroughAViewerBinding(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings
		SET role='viewer',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE id='binding_semantic_apply'`); err != nil {
		t.Fatal(err)
	}
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
	applied, err := service.ApplySemanticMutation(ctx, semanticMutationInput(principal, "invocation-task-viewer"))
	if err != nil || applied.Status != document.SemanticMutationApplied || runtimeCalls != 1 {
		t.Fatalf("Viewer Task Binding mutation=%+v calls=%d error=%v", applied, runtimeCalls, err)
	}
}

// Agent deletion locks the registration a semantic mutation holds while the
// Runtime applies it, so the deletion waits for the mutation to commit.
func TestUnifiedDocumentAgentDeletionWaitsForAnApplyingSemanticMutation(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	runtimeStarted := make(chan struct{})
	releaseRuntime := make(chan struct{})
	calls := 0
	apply := semanticApply(pool, &calls)
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: func(
		ctx context.Context, input document.ApplyRequest,
	) (document.ApplyResult, error) {
		close(runtimeStarted)
		select {
		case <-releaseRuntime:
		case <-ctx.Done():
			return document.ApplyResult{}, ctx.Err()
		}
		return apply(ctx, input)
	}}, objects)
	type applyResult struct {
		result document.SemanticMutationResult
		err    error
	}
	resultCh := make(chan applyResult, 1)
	go func() {
		result, err := service.ApplySemanticMutation(ctx, semanticMutationInput(principal, "invocation-semantic-deletion"))
		resultCh <- applyResult{result: result, err: err}
	}()
	select {
	case <-runtimeStarted:
	case <-time.After(30 * time.Second):
		t.Fatal("semantic mutation did not reach Runtime")
	}
	deletion := make(chan error, 1)
	go func() {
		_, err := pool.Exec(ctx, `UPDATE agent_registrations SET status='revoked'
			WHERE actor_id='actor_agent_a' AND tenant_id='tenant_document_a'`)
		deletion <- err
	}()
	waitForBlockedQuery(t, &testEnv{pool: pool}, "SET status='revoked'")
	close(releaseRuntime)
	if result := receiveWithin(t, resultCh, 30*time.Second); result.err != nil ||
		result.result.Status != document.SemanticMutationApplied {
		t.Fatalf("semantic mutation before deletion result=%+v error=%v", result.result, result.err)
	}
	if err := receiveWithin(t, deletion, 30*time.Second); err != nil {
		t.Fatal(err)
	}
	var seq int
	if err := db.QueryRowContext(ctx, `SELECT seq FROM document_bodies WHERE document_id='document_human_a'`).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if seq != 2 {
		t.Fatalf("body seq=%d", seq)
	}
}

func TestUnifiedDocumentSemanticMutationAdmissionSerializesWithAgentDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	_, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
	deletionTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	deletionCommitted := false
	t.Cleanup(func() {
		if !deletionCommitted {
			_ = deletionTx.Rollback(ctx)
		}
	})
	if _, err := deletionTx.Exec(ctx, `UPDATE agent_registrations SET status='revoked'
		WHERE actor_id='actor_agent_a' AND tenant_id='tenant_document_a'`); err != nil {
		t.Fatal(err)
	}
	type applyResult struct {
		result document.SemanticMutationResult
		err    error
	}
	resultCh := make(chan applyResult, 1)
	go func() {
		result, err := service.ApplySemanticMutation(ctx, semanticMutationInput(principal, "invocation-semantic-admission-deletion"))
		resultCh <- applyResult{result: result, err: err}
	}()
	waitForBlockedQuery(t, &testEnv{pool: pool}, "registration.status")
	if err := deletionTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	deletionCommitted = true
	apply := receiveWithin(t, resultCh, 30*time.Second)
	if !errors.Is(apply.err, document.ErrNotFound) || apply.result.Status != "" || runtimeCalls != 0 {
		t.Fatalf("semantic admission after deletion result=%+v calls=%d error=%v", apply.result, runtimeCalls, apply.err)
	}
}

func TestUnifiedDocumentSemanticMutationReportsAStaleExpectedRevision(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	calls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &calls)}, objects)
	if _, err := db.ExecContext(ctx, `UPDATE document_bodies SET seq=2,state='\x03',state_vector='\x03'
		WHERE document_id='document_human_a'`); err != nil {
		t.Fatal(err)
	}
	input := semanticMutationInput(principal, "invocation-semantic-stale")
	input.ExpectedRevisionID = "revision_semantic_base"
	input.SemanticChange = json.RawMessage(`[{"kind":"replace_body_html","html":"<p data-id=\"a\">x</p>"}]`)
	if _, err := service.ApplySemanticMutation(ctx, input); !errors.Is(err, document.ErrVersionConflict) || calls != 0 {
		t.Fatalf("stale expected Revision calls=%d error=%v", calls, err)
	}
	var histories, replays int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM command_replays WHERE key='invocation-semantic-stale')`).Scan(&histories, &replays); err != nil {
		t.Fatal(err)
	}
	if histories != 0 || replays != 0 {
		t.Fatalf("stale evidence histories=%d replays=%d", histories, replays)
	}
}

func TestUnifiedDocumentSemanticMutationFailsWhenTheRuntimeIsUnavailable(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	runtimeCalls := 0
	apply := semanticApply(pool, &runtimeCalls)
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: func(
		ctx context.Context, input document.ApplyRequest,
	) (document.ApplyResult, error) {
		if runtimeCalls == 0 {
			runtimeCalls++
			return document.ApplyResult{}, errors.Join(document.ErrRuntimeUnavailable, errors.New("Runtime offline"))
		}
		return apply(ctx, input)
	}}, objects)
	input := semanticMutationInput(principal, "invocation-semantic-runtime-failure")
	if _, err := service.ApplySemanticMutation(ctx, input); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("Runtime failure error=%v", err)
	}
	var seq, histories, replays int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT seq FROM document_bodies WHERE document_id='document_human_a'),
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM command_replays WHERE key='invocation-semantic-runtime-failure')
	`).Scan(&seq, &histories, &replays); err != nil {
		t.Fatal(err)
	}
	if seq != 1 || histories != 0 || replays != 0 {
		t.Fatalf("Runtime failure partial state seq=%d histories=%d replays=%d", seq, histories, replays)
	}
	// The Agent retries the same invocation once the Runtime is back.
	result, err := service.ApplySemanticMutation(ctx, input)
	if err != nil || result.Status != document.SemanticMutationApplied || result.Replayed || runtimeCalls != 2 {
		t.Fatalf("retry result=%+v calls=%d error=%v", result, runtimeCalls, err)
	}
}

func TestUnifiedDocumentSemanticMutationReturnsARuntimeConflict(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: func(
		context.Context, document.ApplyRequest,
	) (document.ApplyResult, error) {
		runtimeCalls++
		return document.ApplyResult{ConflictReason: "missing_block"}, nil
	}}, objects)
	input := semanticMutationInput(principal, "invocation-semantic-runtime-conflict")
	result, err := service.ApplySemanticMutation(ctx, input)
	if err != nil || result.Status != document.SemanticMutationConflicted || result.ConflictReason != "missing_block" {
		t.Fatalf("Runtime conflict result=%+v error=%v", result, err)
	}
	var seq, histories, events int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT seq FROM document_bodies WHERE document_id='document_human_a'),
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a')
	`).Scan(&seq, &histories, &events); err != nil {
		t.Fatal(err)
	}
	if seq != 1 || histories != 0 || events != 0 || runtimeCalls != 1 {
		t.Fatalf("Runtime conflict partial seq=%d histories=%d events=%d calls=%d", seq, histories, events, runtimeCalls)
	}
}

func TestUnifiedDocumentSemanticMutationFailsClosedWithoutAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: semanticApply(pool, &runtimeCalls)}, objects)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	missing := semanticMutationInput(principal, "invocation-missing-document")
	missing.DocumentID, missing.TargetID = "document_missing", "document_missing"
	if _, err := service.ApplySemanticMutation(ctx, missing); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("unknown Document ID error=%v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()
		WHERE id=$1`, principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApplySemanticMutation(ctx, semanticMutationInput(principal, "invocation-expired-credential")); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("expired Agent credential error=%v", err)
	}
	var histories, events int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM document_revisions WHERE document_id='document_human_a' AND history_trigger IS NOT NULL),
		(SELECT count(*) FROM document_events WHERE document_id='document_human_a')
	`).Scan(&histories, &events); err != nil {
		t.Fatal(err)
	}
	if runtimeCalls != 0 || histories != 0 || events != 0 {
		t.Fatalf("fail-closed calls=%d histories=%d events=%d", runtimeCalls, histories, events)
	}
}

func TestUnifiedDocumentSemanticMutationPinsTheAssetOfAnImageOrFileEdit(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	if _, err := db.ExecContext(ctx, `INSERT INTO document_assets(
		id,tenant_id,document_id,filename,media_type,sha256,size_bytes,content_object_id,status
	) VALUES('asset_canvas_image','tenant_document_a','document_human_a','card.png',
		'image/png',repeat('a',64),3,'object_canvas_image','available'),
		('asset_a_second_image','tenant_document_a','document_human_a','rally.png',
		'image/png',repeat('b',64),3,'object_second_image','available'),
		('asset_plan_pdf','tenant_document_a','document_human_a','plan.pdf',
		'application/pdf',repeat('c',64),3,'object_plan_pdf','available')`); err != nil {
		t.Fatal(err)
	}
	var allowed [][]string
	calls := 0
	apply := semanticApply(pool, &calls)
	service := document.NewWithRuntime(pool, documentRuntimeStub{apply: func(
		ctx context.Context, input document.ApplyRequest,
	) (document.ApplyResult, error) {
		allowed = append(allowed, input.Semantic.AllowedAssetIDs)
		return apply(ctx, input)
	}}, objects)
	imageEdit := func(invocationID, assetID string) document.ApplySemanticMutationInput {
		input := semanticMutationInput(principal, invocationID)
		input.SemanticChange = json.RawMessage(`[{"kind":"edit_document","parser_version":"markdown-v1",` +
			`"command":"image_insert_after","block_id":"first","asset_id":"` + assetID + `"}]`)
		return input
	}
	if _, err := service.ApplySemanticMutation(ctx, imageEdit("invocation-image-edit", "asset_canvas_image")); err != nil {
		t.Fatalf("image edit error=%v", err)
	}
	if len(allowed) != 1 || !slices.Contains(allowed[0], "asset_canvas_image") {
		t.Fatalf("runtime allowed Assets=%v", allowed)
	}
	var placed bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM document_bodies body
		JOIN document_revisions revision ON revision.id=current_document_revision_id(body.document_id)
		CROSS JOIN jsonb_array_elements(revision.asset_manifest) manifest(value)
		WHERE body.document_id='document_human_a' AND manifest.value->>'asset_id'='asset_canvas_image')`).Scan(&placed); err != nil {
		t.Fatal(err)
	}
	if !placed {
		t.Fatal("the image edit's Asset is missing from the History Revision")
	}
	// An image edit naming an Asset that is not available never reaches the runtime.
	if _, err := service.ApplySemanticMutation(ctx, imageEdit("invocation-image-missing", "asset_missing")); !errors.Is(err, document.ErrInvalidInput) || len(allowed) != 1 {
		t.Fatalf("missing Asset error=%v runtime calls=%d", err, len(allowed))
	}
	// A second image joins the one already placed; the runtime receives both, sorted.
	if _, err := service.ApplySemanticMutation(ctx, imageEdit("invocation-image-second", "asset_a_second_image")); err != nil {
		t.Fatalf("second image edit error=%v", err)
	}
	if len(allowed) != 2 || !slices.Equal(allowed[1], []string{"asset_a_second_image", "asset_canvas_image"}) {
		t.Fatalf("runtime allowed Assets=%v", allowed)
	}
	// An image edit never places a file; a file edit places it as a file block.
	if _, err := service.ApplySemanticMutation(ctx, imageEdit("invocation-image-pdf", "asset_plan_pdf")); !errors.Is(err, document.ErrInvalidInput) || len(allowed) != 2 {
		t.Fatalf("image edit of a PDF error=%v runtime calls=%d", err, len(allowed))
	}
	fileEdit := semanticMutationInput(principal, "invocation-file-edit")
	fileEdit.SemanticChange = json.RawMessage(`[{"kind":"edit_document","parser_version":"markdown-v1",` +
		`"command":"file_insert_after","block_id":"first","asset_id":"asset_plan_pdf","name":"plan.pdf"}]`)
	if _, err := service.ApplySemanticMutation(ctx, fileEdit); err != nil || len(allowed) != 3 || !slices.Contains(allowed[2], "asset_plan_pdf") {
		t.Fatalf("file edit error=%v runtime allowed Assets=%v", err, allowed)
	}
	// The Agent uploads an image under its write access; the same operation replays it,
	// and the bytes, not the name, decide the type.
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00")
	upload := document.CreateAgentAssetInput{TenantID: "tenant_document_a", AgentID: "agent_document_a",
		DocumentID: "document_human_a", Filename: "card-blue.png", OperationID: "operation-card-blue"}
	upload.Contents = bytes.NewReader(png)
	first, err := service.CreateAgentAsset(ctx, upload)
	if err != nil || first.Asset.Status != "available" || first.Asset.MediaType != "image/png" || first.Replayed {
		t.Fatalf("upload=%+v error=%v", first, err)
	}
	upload.Contents = bytes.NewReader(png)
	again, err := service.CreateAgentAsset(ctx, upload)
	if err != nil || again.Asset.ID != first.Asset.ID || !again.Replayed {
		t.Fatalf("replay=%+v error=%v", again, err)
	}
	// A supported file is stored as the type its bytes show; anything else is refused.
	upload.OperationID, upload.Filename, upload.Contents = "operation-plan", "plan.pdf", bytes.NewReader([]byte("%PDF-1.7\nplan"))
	if pdf, err := service.CreateAgentAsset(ctx, upload); err != nil || pdf.Asset.MediaType != "application/pdf" {
		t.Fatalf("PDF upload=%+v error=%v", pdf, err)
	}
	upload.OperationID, upload.Filename, upload.Contents = "operation-page", "page.pdf", bytes.NewReader([]byte("<html><body>x</body></html>"))
	if _, err := service.CreateAgentAsset(ctx, upload); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("unsupported upload error=%v", err)
	}
	upload.Filename = "card-blue.png"
	upload.AgentID, upload.OperationID, upload.Contents = "agent_unknown", "operation-other-agent", bytes.NewReader(png)
	if _, err := service.CreateAgentAsset(ctx, upload); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("unauthorized upload error=%v", err)
	}
}

func semanticMutationInput(principal *agentcredential.Principal, invocationID string) document.ApplySemanticMutationInput {
	return document.ApplySemanticMutationInput{
		Principal:          principal,
		TargetKind:         "document",
		TargetID:           "document_human_a",
		DocumentID:         "document_human_a",
		SourceInvocationID: invocationID,
		SchemaVersion:      "blocknote-semantic-v1",
		SemanticChange:     json.RawMessage(`[{"kind":"set_title","title":"Agent title"}]`),
	}
}

// semanticApply is a Runtime apply that saves the Agent title change as a new
// body state and counts its calls.
func semanticApply(pool *pgxpool.Pool, calls *int) func(context.Context, document.ApplyRequest) (document.ApplyResult, error) {
	return applyToBody(pool, func(input document.ApplyRequest, _ []byte) ([]byte, []byte, []string, []string, string, error) {
		*calls++
		if input.Semantic == nil {
			return nil, nil, nil, nil, "", errors.New("expected a semantic change")
		}
		return []byte{4, 5, 6}, []byte{2}, input.Semantic.AllowedAssetIDs, nil, "Agent title", nil
	})
}

func newUnifiedDocumentSemanticMutationFixture(t *testing.T) (*sql.DB, *pgxpool.Pool, artifactstore.ObjectStore) {
	t.Helper()
	baseState := []byte{1, 2, 3}
	db, pool := newUnifiedDocumentFixture(t, `INSERT INTO work_item_assignments(
		work_item_id,tenant_id,actor_id,assigned_by_actor_id
	) VALUES('work_item_document_a','tenant_document_a','actor_agent_a','actor_human_a');
INSERT INTO document_revisions(
		id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
		state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
	) VALUES('revision_semantic_base','tenant_document_a','document_human_a',1,'\x01',$1,
		$2,$1,'[]'::jsonb,'actor_human_a');
INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',1,'\x01',$1,
			'revision_semantic_base','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;

		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,work_item_id,status
		) VALUES('binding_semantic_apply','tenant_document_a','document_human_a',
			'task','work_item_document_a','active');
`, semanticDigest(baseState), baseState)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	return db, pool, objects
}

// insertUnifiedDocumentRoomSemanticMutationBinding gives the fixture Agent a
// second, Room-bound route to write the Document beside its Task binding.
func insertUnifiedDocumentRoomSemanticMutationBinding(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
		 ('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a'),
		 ('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a');
		INSERT INTO document_context_bindings(
		 id,tenant_id,document_id,binding_kind,room_id,role,status
		) VALUES('binding_room_semantic_apply','tenant_document_a','document_human_a','room',
		 'room_document_a','editor','active')
	`); err != nil {
		t.Fatal(err)
	}
}

func semanticDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
