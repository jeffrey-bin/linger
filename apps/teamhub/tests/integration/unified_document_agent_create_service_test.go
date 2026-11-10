package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// A Task's AlterEgo writes to its playground, never to a new Document bound
// to the Task: a Task target cannot create one.
func TestUnifiedDocumentAgentCreateRejectsTaskTarget(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	runtime := func(context.Context, document.ImportRequest) (document.ImportedState, error) {
		t.Fatal("a Task target reached Document materialization")
		return document.ImportedState{}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: runtime}, nil)
	_, err := service.CreateAgentDocument(ctx, document.CreateAgentDocumentInput{
		Principal: issueAgentPrincipal(t, pool, "agent_document_a"), TargetKind: "task", TargetID: "work_item_document_a",
		SourceInvocationID: "jsonrpc-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Title:              "Agent document", Markdown: "# Body\n",
	})
	if !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("Task target Document creation error=%v want ErrNotFound", err)
	}
	var documents int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM documents WHERE creator_actor_id='actor_agent_a'`).Scan(&documents); err != nil {
		t.Fatal(err)
	}
	if documents != 0 {
		t.Fatalf("Task target Documents=%d want=0", documents)
	}
}

// An Agent's Room Document binds the Room as manager; the Space's single
// Human and every Agent own it like every active Document.
func TestUnifiedDocumentAgentRoomCreateBindsTheRoomAsManager(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
		 ('actor_agent_peer','tenant_document_a','agent','Agent Peer',NULL,'agent-document-peer');
		INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,computer_id,local_runtime_type,workspace_grant_id)
		 VALUES('actor_agent_peer','tenant_document_a','agent_document_peer','active','Peer','test-model','actor_human_a','computer_fixture','codex','grant_files');
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
		 ('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a'),
		 ('room_document_a','tenant_document_a','actor_agent_peer','member','actor_human_a');
	`); err != nil {
		t.Fatal(err)
	}
	runtime := func(context.Context, document.ImportRequest) (document.ImportedState, error) {
		state := []byte{4, 5, 6}
		return document.ImportedState{StateBytes: state, StateBytesSHA256: semanticDigest(state), StateVector: []byte{1}, FullStateFingerprint: semanticDigest(state), StateHashVersion: 1, CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{}}, nil
	}
	created, err := document.NewWithRuntime(pool, documentRuntimeStub{importer: runtime}, nil).CreateAgentDocument(ctx, document.CreateAgentDocumentInput{Principal: issueAgentPrincipal(t, pool, "agent_document_a"), TargetKind: "room", TargetID: "room_document_a", SourceInvocationID: "jsonrpc-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Title: "Room Agent document", Markdown: "# Room\n"})
	if err != nil {
		t.Fatal(err)
	}
	roles := func() (binding, human, agentPeer string, directSources int) {
		t.Helper()
		if err := db.QueryRowContext(ctx, `SELECT
		 (SELECT role FROM document_context_bindings WHERE document_id=$1 AND binding_kind='room'),
		 (SELECT content_role FROM resolve_human_document_access_v2('account_document_a',$1)),
		 (SELECT content_role FROM resolve_agent_document_access_v2('agent_document_peer',$1)),
		 (SELECT count(*) FROM document_direct_collaborators WHERE document_id=$1)`, created.DocumentID).Scan(&binding, &human, &agentPeer, &directSources); err != nil {
			t.Fatal(err)
		}
		return binding, human, agentPeer, directSources
	}
	if binding, human, agentPeer, direct := roles(); binding != "manager" || human != "owner" || agentPeer != "owner" || direct != 0 {
		t.Fatalf("roles=%s/%s/%s direct=%d", binding, human, agentPeer, direct)
	}
	// Downgrading the Binding to Editor leaves every Actor's access.
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings SET role='editor',access_epoch=access_epoch+1,updated_at=clock_timestamp() WHERE document_id=$1`, created.DocumentID); err != nil {
		t.Fatal(err)
	}
	if binding, human, agentPeer, _ := roles(); binding != "editor" || human != "owner" || agentPeer != "owner" {
		t.Fatalf("editor roles=%s/%s/%s", binding, human, agentPeer)
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: runtime}, nil)
	input := document.TrashDocumentInput{AccountID: "account_document_a", DocumentID: created.DocumentID}
	if err := service.Trash(ctx, input); err != nil {
		t.Fatalf("Human trash err=%v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM documents WHERE id=$1`, created.DocumentID).Scan(&status); err != nil || status != "trashed" {
		t.Fatalf("Human trash status=%q err=%v", status, err)
	}
}

func TestUnifiedDocumentAgentCreateFailsClosedForRuntimeAndAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	addUnifiedDocumentAgentRoomMember(t, ctx, db)
	runtimeCalls := 0
	service := document.NewWithRuntime(pool, documentRuntimeStub{importer: func(
		context.Context,
		document.ImportRequest,
	) (document.ImportedState, error) {
		runtimeCalls++
		return document.ImportedState{}, document.ErrRuntimeUnavailable
	}}, nil)
	input := agentRoomDocumentInput(issueAgentPrincipal(t, pool, "agent_document_a"),
		"jsonrpc-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Agent document")
	missingRuntimeInput := input
	missingRuntimeInput.SourceInvocationID = "jsonrpc-sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	if _, err := document.New(pool).CreateAgentDocument(ctx, missingRuntimeInput); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("missing Runtime error=%v", err)
	}
	if _, err := service.CreateAgentDocument(ctx, input); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("runtime error=%v", err)
	}
	var documents, replays int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM documents WHERE title='Agent document'),
		(SELECT count(*) FROM command_replays WHERE key=$1)
	`, input.SourceInvocationID).Scan(&documents, &replays); err != nil {
		t.Fatal(err)
	}
	if documents != 0 || replays != 0 || runtimeCalls != 1 {
		t.Fatalf("partial state documents=%d replays=%d calls=%d", documents, replays, runtimeCalls)
	}
	unrelatedTask := input
	unrelatedTask.SourceInvocationID = "jsonrpc-sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	unrelatedTask.TargetID = "work_item_missing"
	if _, err := service.CreateAgentDocument(ctx, unrelatedTask); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("unrelated Task error=%v", err)
	}
	if runtimeCalls != 1 {
		t.Fatalf("runtime called without authority: %d", runtimeCalls)
	}
}

func TestUnifiedDocumentAgentCreateSettlementSerializesWithAgentDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, _ := newUnifiedDocumentSemanticMutationFixture(t)
	addUnifiedDocumentAgentRoomMember(t, ctx, db)
	principal := issueAgentPrincipal(t, pool, "agent_document_a")
	runtimeStarted := make(chan struct{})
	releaseRuntime := make(chan struct{})
	runtime := func(
		ctx context.Context,
		_ document.ImportRequest,
	) (document.ImportedState, error) {
		close(runtimeStarted)
		select {
		case <-releaseRuntime:
		case <-ctx.Done():
			return document.ImportedState{}, ctx.Err()
		}
		state := []byte{7, 8, 9}
		return document.ImportedState{
			StateBytes: state, StateBytesSHA256: semanticDigest(state), StateVector: []byte{1},
			FullStateFingerprint: semanticDigest(state), StateHashVersion: 1,
			CompleteAssetIDs: []string{}, CompleteThreadIDs: []string{},
		}, nil
	}
	type createResult struct {
		result document.CreateAgentDocumentResult
		err    error
	}
	resultCh := make(chan createResult, 1)
	go func() {
		result, err := document.NewWithRuntime(pool, documentRuntimeStub{importer: runtime}, nil).CreateAgentDocument(ctx,
			agentRoomDocumentInput(principal,
				"jsonrpc-sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "Must not be created"))
		resultCh <- createResult{result: result, err: err}
	}()
	receiveWithin(t, runtimeStarted, 30*time.Second)

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
	if _, err := deletionTx.Exec(ctx, `SELECT status FROM agent_registrations
		WHERE actor_id='actor_agent_a' AND tenant_id='tenant_document_a' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	if _, err := deletionTx.Exec(ctx, `UPDATE agent_registrations SET status='revoked'
		WHERE actor_id='actor_agent_a' AND tenant_id='tenant_document_a'`); err != nil {
		t.Fatal(err)
	}
	close(releaseRuntime)
	waitForBlockedQuery(t, &testEnv{pool: pool}, "SELECT status FROM agent_registrations")
	if err := deletionTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	deletionCommitted = true
	created := receiveWithin(t, resultCh, 30*time.Second)
	if !errors.Is(created.err, document.ErrNotFound) || created.result.DocumentID != "" {
		t.Fatalf("Agent create settlement after deletion result=%+v error=%v", created.result, created.err)
	}
	var documents, drafts, bindings, events int
	var registrationStatus string
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM documents WHERE title='Must not be created'),
		(SELECT count(*) FROM document_bodies draft JOIN documents document ON document.id=draft.document_id
		 WHERE document.title='Must not be created'),
		(SELECT count(*) FROM document_context_bindings binding JOIN documents document
		 ON document.id=binding.document_id WHERE document.title='Must not be created'),
		(SELECT count(*) FROM document_events event JOIN documents document
		 ON document.id=event.document_id WHERE document.title='Must not be created'),
		(SELECT status FROM agent_registrations WHERE actor_id='actor_agent_a')`).Scan(
		&documents, &drafts, &bindings, &events, &registrationStatus,
	); err != nil {
		t.Fatal(err)
	}
	if documents != 0 || drafts != 0 || bindings != 0 || events != 0 || registrationStatus != "revoked" {
		t.Fatalf("deletion-first create documents=%d drafts=%d bindings=%d events=%d registration=%s",
			documents, drafts, bindings, events, registrationStatus)
	}
}

// agentRoomDocumentInput creates a Document in room_document_a, the Room
// addUnifiedDocumentAgentRoomMember puts the fixture Agent in.
func agentRoomDocumentInput(principal *agentcredential.Principal, invocationID, title string) document.CreateAgentDocumentInput {
	return document.CreateAgentDocumentInput{
		Principal: principal, TargetKind: "room", TargetID: "room_document_a",
		SourceInvocationID: invocationID, Title: title, Markdown: "body",
	}
}

// addUnifiedDocumentAgentRoomMember makes the fixture Agent a member of
// room_document_a; an Agent Document binds only to a Room.
func addUnifiedDocumentAgentRoomMember(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a')`); err != nil {
		t.Fatal(err)
	}
}
