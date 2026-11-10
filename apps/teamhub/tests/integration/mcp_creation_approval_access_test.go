package integration_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// These subcases reuse the real MCP proposal and approval chain's private DB.
// The approver is the Space's only Human, who reads and shares every active
// Document, so an artifact is skipped only when its Document or frozen content
// is gone; approval holds the Document and the Human steady until it commits.
func assertRoomCreationApprovalAccessTransactions(t *testing.T, env *testEnv, alice *http.Client,
	service *agentcreationapproval.Service, token string,
	roomInput agentcreationapproval.Input, documentID, otherDocumentID string,
) {
	decisions := typedcard.New(env.pool)
	exec := func(t *testing.T, query string, args ...any) {
		t.Helper()
		if _, err := env.pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	sourceRoomID := strings.TrimPrefix(roomInput.SourceInboxIDs[0], "room:")
	submit := func(t *testing.T, artifacts ...string) agentcreationapproval.Result {
		t.Helper()
		input := roomInput
		caller, effective := *input.RoomCaller, *input.RoomEffective
		caller.Name = "Access transaction " + mcpCreationInvocationID(t.Name())[24:56]
		effective.Name = caller.Name
		if len(artifacts) > 0 {
			caller.Artifacts, effective.Artifacts = artifacts, artifacts
		}
		input.RoomCaller, input.RoomEffective = &caller, &effective
		input.InvocationID = mcpCreationInvocationID(t.Name())
		// The requesting Meta sends its source Room Context.
		roomCtx := agentauth.WithTarget(t.Context(), "room", sourceRoomID)
		pending, err := service.Submit(roomCtx, token, input)
		if err != nil {
			t.Fatal(err)
		}
		return pending
	}
	decide := func(ctx context.Context, pending agentcreationapproval.Result) (typedcard.CreateResult, error) {
		return decisions.DecideDecision(ctx, "account_alice", pending.CreationApprovalRequestID,
			typedcard.DecisionAnswerCommand{Decision: "approve", ExpectedVersion: 1})
	}
	assertDelivered := func(t *testing.T, pending agentcreationapproval.Result, artifactIDs ...string) string {
		t.Helper()
		var roomID, runtimeBody string
		if err := env.pool.QueryRow(t.Context(), `SELECT request.result->'data'->>'created_room_id',message.body
   FROM decisions request JOIN messages message ON message.card_context_message_id=request.message_id
   AND message.message_kind='agent_runtime' WHERE request.id=$1 AND request.status='succeeded'`,
			pending.CreationApprovalRequestID).Scan(&roomID, &runtimeBody); err != nil {
			t.Fatal(err)
		}
		if len(artifactIDs) == 0 {
			artifactIDs = []string{documentID, otherDocumentID}
		}
		for _, artifactID := range artifactIDs {
			if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE room_id=$1 AND document_id=$2`, roomID, artifactID); got != 1 {
				t.Fatalf("artifact %s bindings=%d want=1 runtime=%s", artifactID, got, runtimeBody)
			}
		}
		if !strings.Contains(runtimeBody, `"skipped_artifacts":[]`) {
			t.Fatalf("runtime=%s", runtimeBody)
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 OR card_context_message_id=$2`, roomID, pending.MessageID); got != 4 {
			t.Fatalf("initial/handoff/result/runtime messages=%d want=4", got)
		}
		return roomID
	}
	// A transaction-owned barrier pauses real approval after review, at Room insert.
	barrier := func(t *testing.T) pgx.Tx {
		exec(t, `CREATE FUNCTION approval_room_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.name LIKE 'Access transaction %' THEN PERFORM pg_advisory_xact_lock(1746001); END IF;
   RETURN NEW; END $$;
   CREATE TRIGGER approval_room_barrier BEFORE INSERT ON rooms FOR EACH ROW EXECUTE FUNCTION approval_room_barrier()`)
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(t.Context(), `SELECT pg_advisory_xact_lock(1746001)`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = tx.Rollback(context.Background())
			exec(t, `DROP TRIGGER approval_room_barrier ON rooms; DROP FUNCTION approval_room_barrier()`)
		})
		return tx
	}
	waitBlockedBy := func(t *testing.T, blockerPID int, waitEvent string) int {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var waiterPID int
			err := env.pool.QueryRow(t.Context(), `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
  AND ($2='' OR wait_event=$2) AND $1=ANY(pg_blocking_pids(pid))`, blockerPID, waitEvent).Scan(&waiterPID)
			if err == nil {
				return waiterPID
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("transaction did not reach the expected lock barrier")
		return 0
	}
	backendPID := func(t *testing.T, tx pgx.Tx) int {
		t.Helper()
		var pid int
		if err := tx.QueryRow(t.Context(), `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		return pid
	}
	asyncDecision := func(t *testing.T, pending agentcreationapproval.Result) <-chan error {
		results := make(chan error, 1)
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		t.Cleanup(cancel)
		go func() { _, err := decide(ctx, pending); results <- err }()
		return results
	}
	t.Run("trashing a reviewed artifact waits for delivery commit", func(t *testing.T) {
		// A Document of its own: trashing is final for the shared artifacts.
		status, _, body := requestUnifiedDocumentMultipart(
			t, env, alice, "/v0/rooms/"+sourceRoomID+"/documents/uploads", "trash-wait-"+mcpCreationInvocationID(t.Name())[24:56],
			map[string]string{"filename": "trash-wait.txt", "representation_format": "plain_text", "media_type": "text/plain"},
			"trash-wait.txt", []byte("trashed while approval delivers\n"),
		)
		if status != http.StatusCreated {
			t.Fatalf("upload trash-wait artifact status=%d body=%s", status, body)
		}
		var artifact uploadedDocumentRef
		decode(t, body, &artifact)
		pending := submit(t, artifact.ID)
		roomBarrier := barrier(t)
		result := asyncDecision(t, pending)
		// The approval has reviewed and locked every artifact before the Room insert.
		approvalPID := waitBlockedBy(t, backendPID(t, roomBarrier), "advisory")
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		trashResult := make(chan error, 1)
		go func() {
			_, err := env.pool.Exec(ctx, `UPDATE documents SET status='trashed',trashed_at=GREATEST(updated_at,clock_timestamp()),
   updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id=$1 AND status='active'`, artifact.ID)
			trashResult <- err
		}()
		// The Document row, rather than the Room barrier, must block the trash.
		waitBlockedBy(t, approvalPID, "")
		if err := roomBarrier.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := <-result; err != nil {
			t.Fatal(err)
		}
		if err := <-trashResult; err != nil {
			t.Fatal(err)
		}
		assertDelivered(t, pending, artifact.ID)
	})
	t.Run("reviewed artifact and Human resist mutation until commit", func(t *testing.T) {
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(t.Context())
		var versionID string
		if err := env.pool.QueryRow(t.Context(), `SELECT current_version_id FROM documents WHERE id=$1`, documentID).Scan(&versionID); err != nil {
			t.Fatal(err)
		}
		_, reason, err := document.LockRoomCreationArtifactInTransaction(t.Context(), tx, "account_alice", acmeTenant, documentID, versionID, "")
		if err != nil || reason != "" {
			t.Fatalf("review reason=%q err=%v", reason, err)
		}
		for _, query := range []string{
			`UPDATE documents SET status='trashed',trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id='` + documentID + `'`,
			`SELECT id FROM documents WHERE id='` + documentID + `' FOR UPDATE NOWAIT`,
			`UPDATE actors SET account_id=NULL WHERE id='actor_acme_alice'`,
		} {
			mutation, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := mutation.Exec(t.Context(), `SET LOCAL lock_timeout='100ms'`); err != nil {
				t.Fatal(err)
			}
			_, err = mutation.Exec(t.Context(), query)
			_ = mutation.Rollback(t.Context())
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Fatalf("mutation was not serialized: %s err=%v", query, err)
			}
		}
	})
	t.Run("concurrent approvals create one Room", func(t *testing.T) {
		pending := submit(t)
		before := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
		start := make(chan struct{})
		results := make(chan error, 2)
		for range 2 {
			go func() {
				<-start
				_, err := decide(t.Context(), pending)
				results <- err
			}()
		}
		close(start)
		first, second := <-results, <-results
		if !((first == nil && errors.Is(second, typedcard.ErrConflict)) || (second == nil && errors.Is(first, typedcard.ErrConflict))) {
			t.Fatalf("concurrent approval results=%v %v", first, second)
		}
		if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != before+1 {
			t.Fatalf("rooms=%d want=%d", got, before+1)
		}
		roomID := assertDelivered(t, pending)
		if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE room_id=$1`, roomID); got != 2 {
			t.Fatalf("bindings=%d", got)
		}
	})
	for _, failure := range []string{"binding", "notification", "handoff", "binding evidence missing"} {
		t.Run(failure+" failure rolls back all approval facts", func(t *testing.T) {
			pending := submit(t)
			facts := []string{"rooms", "document_context_bindings", "messages", "room_events", "command_replays"}
			before := make([]int, len(facts))
			for i, table := range facts {
				before[i] = countRows(t, env, "SELECT count(*) FROM "+table)
			}
			triggerTable, condition := "document_context_bindings", "NEW.document_id='"+otherDocumentID+"' AND NEW.room_id<>'"+roomInput.SourceInboxIDs[0][5:]+"'"
			if failure == "notification" {
				triggerTable = "messages"
				condition = "NEW.message_kind='agent_runtime' AND NEW.card_context_message_id='" + pending.MessageID + "'"
			}
			if failure == "handoff" {
				handoffDigest := sha256.Sum256([]byte("room-creation-handoff:" + pending.CreationApprovalRequestID))
				triggerTable = "messages"
				condition = fmt.Sprintf("NEW.id='message_%x'", handoffDigest[:16])
			}
			failureAction := "RAISE EXCEPTION 'injected approval write failure';"
			triggerTiming := "BEFORE"
			if failure == "binding evidence missing" {
				// A post-insert ErrNotFound is a write failure, not a skippable denial.
				failureAction = "UPDATE documents SET status='trashed',trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id=NEW.document_id;"
				triggerTiming = "AFTER"
			}
			exec(t, `CREATE FUNCTION approval_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF `+condition+` THEN `+
				failureAction+` END IF; RETURN NEW; END $$;
    CREATE TRIGGER approval_write_failure `+triggerTiming+` INSERT ON `+triggerTable+` FOR EACH ROW EXECUTE FUNCTION approval_write_failure()`)

			t.Cleanup(func() {
				exec(t, `DROP TRIGGER approval_write_failure ON `+triggerTable+`; DROP FUNCTION approval_write_failure()`)
			})
			if _, err := decide(t.Context(), pending); err == nil ||
				(failure != "binding evidence missing" && !strings.Contains(err.Error(), "injected approval write failure")) ||
				(failure == "binding evidence missing" && !errors.Is(err, typedcard.ErrConflict)) {
				t.Fatalf("write failure err=%v", err)
			}
			if got := countRows(t, env, `SELECT count(*) FROM documents WHERE id=$1 AND status='active'`, otherDocumentID); got != 1 {
				t.Fatal("Document status did not roll back")
			}
			for i, table := range facts {
				if got := countRows(t, env, "SELECT count(*) FROM "+table); got != before[i] {
					t.Fatalf("%s count=%d want=%d", table, got, before[i])
				}
			}
			if got := countRows(t, env, `SELECT count(*) FROM decisions request JOIN message_cards card ON card.message_id=request.message_id
    WHERE request.id=$1 AND request.status='pending' AND request.result IS NULL AND card.version=1`, pending.CreationApprovalRequestID); got != 1 {
				t.Fatal("approval/card state did not roll back")
			}
		})
	}
}
