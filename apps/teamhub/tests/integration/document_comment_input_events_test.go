package integration_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
)

// waitForRiverSweepRan waits until a periodic sweep of kind has finished since
// start, so a test that only the sweep can settle starts its own wait after the
// sweep is running. It is readiness, not the business wait that follows.
func waitForRiverSweepRan(t *testing.T, env *testEnv, kind string, start time.Time) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var ran bool
		if err := env.pool.QueryRow(t.Context(), `SELECT EXISTS(
			SELECT 1 FROM river_job WHERE kind=$1 AND state='completed' AND finalized_at>=$2)`,
			kind, start).Scan(&ran); err != nil {
			t.Fatal(err)
		}
		if ran {
			return
		}
		if time.Now().After(deadline) {
			var leader string
			if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(
				(SELECT format('leader=%s elected_at=%s expires_at=%s', leader_id, elected_at, expires_at)
				 FROM river_leader LIMIT 1),'no leader')`).Scan(&leader); err != nil {
				leader = err.Error()
			}
			t.Fatalf("River sweep %s did not finish since %s: %s", kind, start.Format(time.RFC3339Nano), leader)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// createAgentMentionThread creates a Document in the Room and a Comment that
// mentions the Room's Agent, and returns the Document, Thread, and comment Run.
func createAgentMentionThread(
	t *testing.T, env *testEnv, alice *http.Client, name, suffix string,
) (roomDocumentResponse, roomDocumentCommentThreadResponse, string) {
	t.Helper()
	roomID := createPrivateRoom(t, env, alice, name+" "+suffix, name+"-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, name+"-member-"+suffix)
	doc := createRoomDocumentForCommentRefs(t, env, alice, roomID, name, name+"-document-"+suffix)
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_" + suffix,
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(doc.DurableHead.PersistedSeq, doc.DurableHead.StateHash, doc.DurableHead.StateHashVersion),
	}, name+"-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent-mentioned Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	return doc, thread, waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
}

func TestDocumentCommentInputEventsSettleWithoutSweep(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true,
		appOptions:     []appOption{skipping(app.DocumentCommentSweep)},
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)

	attachedDoc, attached, attachedRun := createAgentMentionThread(t, env, alice, "events-attach", suffix)
	attachDocumentAgentThread(t, env, alice, attachedDoc.ID, attached.ID, "events-attach-"+suffix)
	waitForDocumentCommentRunQueued(t, env, attachedRun, "active")

	_, resolved, resolvedRun := createAgentMentionThread(t, env, alice, "events-resolve", suffix)
	status, _, body := env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+resolved.ID, map[string]any{"resolved": true}, "events-resolve-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resolve Agent-mentioned Comment status=%d body=%s", status, body)
	}
	waitForDocumentCommentRunFailed(t, env, resolvedRun)
}

// The creation job can run before the Runtime saves the body that attaches
// the Thread; that save then wakes the queued Run itself, without the sweep.
func TestDocumentBodySaveAttachingAThreadWakesItsCommentRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true,
		appOptions:     []appOption{skipping(app.DocumentCommentSweep)},
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	doc, thread, runID := createAgentMentionThread(t, env, alice, "body-attach", suffix)
	deadline := time.Now().Add(30 * time.Second)
	for countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='document.comment_input'
		AND args->>'run_id'=$1 AND state='completed'`, runID) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the creation comment input job did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	waitForDocumentCommentRunQueued(t, env, runID, "suspended")

	attachDocumentAgentThread(t, env, alice, doc.ID, thread.ID, "body-attach-"+suffix)
	waitForDocumentCommentRunQueued(t, env, runID, "active")
}

// A body save that orphans a Thread announces it in every Room the Document
// is bound to, so open pages drop the Thread without a reload.
func TestDocumentBodySaveOrphaningAThreadAnnouncesItInEachBoundRoom(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	doc, thread, _ := createAgentMentionThread(t, env, alice, "body-orphan", suffix)
	attachDocumentAgentThread(t, env, alice, doc.ID, thread.ID, "body-orphan-"+suffix)
	const actorID = "actor_acme_alice"
	otherRoomID := createPrivateRoom(t, env, alice, "Second binding "+suffix, "body-orphan-second-"+suffix)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,room_id,status)
		VALUES($1,$2,$3,'room',$4,'active')`, "binding_body_orphan_"+suffix, acmeTenant, doc.ID, otherRoomID); err != nil {
		t.Fatal(err)
	}
	roomEvents := func() map[string]int {
		rows, err := env.pool.Query(t.Context(), `SELECT binding.room_id,count(event.event_id)
			FROM document_context_bindings binding
			LEFT JOIN room_events event ON event.room_id=binding.room_id
			 AND event.event_type='document.comment.changed' AND event.resource_id=$2
			 AND event.payload->>'change_kind'='thread_reanchored'
			WHERE binding.document_id=$1 AND binding.binding_kind='room' AND binding.status='active'
			GROUP BY binding.room_id`, doc.ID, thread.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		counts := map[string]int{}
		for rows.Next() {
			var roomID string
			var count int
			if err := rows.Scan(&roomID, &count); err != nil {
				t.Fatal(err)
			}
			counts[roomID] = count
		}
		return counts
	}
	before := roomEvents()
	if len(before) != 2 {
		t.Fatalf("bound Rooms=%v want 2", before)
	}

	appendCommentThreadRefs(t, env, doc.ID, actorID, "body-orphan-save-"+suffix, 1, []string{})
	var status string
	if err := env.pool.QueryRow(t.Context(), `SELECT anchor_status FROM room_document_comment_threads WHERE id=$1`, thread.ID).Scan(&status); err != nil || status != "orphaned" {
		t.Fatalf("Thread anchor status=%q err=%v", status, err)
	}
	after := roomEvents()
	for roomID, count := range after {
		if count != before[roomID]+1 {
			t.Fatalf("Room %s Thread events %d -> %d, want one more", roomID, before[roomID], count)
		}
	}
	var payload, eventActorID string
	if err := env.pool.QueryRow(t.Context(), `SELECT payload::text,actor_id FROM room_events
		WHERE room_id=$1 AND event_type='document.comment.changed' AND resource_id=$2
		ORDER BY room_seq DESC LIMIT 1`, otherRoomID, thread.ID).Scan(&payload, &eventActorID); err != nil {
		t.Fatal(err)
	}
	want := `{"kind": "document.comment.changed", "thread_id": "` + thread.ID + `", "change_kind": "thread_reanchored", "document_id": "` + doc.ID + `"}`
	if payload != want || eventActorID != actorID {
		t.Fatalf("Room Event payload=%s actor=%s want %s by %s", payload, eventActorID, want, actorID)
	}
}

// A new comment Run is also scheduled at its 24-hour limit, so a Run still
// queued then fails at that time without the safety-net sweep.
func TestDocumentCommentRunFailsAtItsLimitWithoutSweep(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true,
		appOptions:     []appOption{skipping(app.DocumentCommentSweep)},
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	_, _, runID := createAgentMentionThread(t, env, alice, "events-limit", suffix)
	var jobID int64
	var scheduledAt, limit time.Time
	if err := env.pool.QueryRow(t.Context(), `SELECT job.id,job.scheduled_at,local_run.created_at+interval '24 hours'
		FROM river_job job JOIN agent_local_runs local_run ON local_run.run_id=job.args->>'run_id'
		WHERE job.kind='document.comment_input' AND job.state='scheduled' AND job.args->>'run_id'=$1`,
		runID).Scan(&jobID, &scheduledAt, &limit); err != nil {
		t.Fatalf("comment input scheduled at the Run limit: %v", err)
	}
	if !scheduledAt.Equal(limit) {
		t.Fatalf("comment input scheduled_at=%s want %s", scheduledAt, limit)
	}

	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SET LOCAL session_replication_role='replica'`); err != nil {
		t.Fatal(err)
	}
	command, err := tx.Exec(t.Context(), `UPDATE agent_local_runs
		SET created_at=clock_timestamp()-interval '25 hours'
		WHERE run_id=$1 AND status='queued'`, runID)
	if err != nil || command.RowsAffected() != 1 {
		t.Fatalf("age Document comment Run changed=%d err=%v", command.RowsAffected(), err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE river_job SET scheduled_at=now() WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitForDocumentCommentRunFailed(t, env, runID)
}
