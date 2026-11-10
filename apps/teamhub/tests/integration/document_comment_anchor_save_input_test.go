package integration_test

import (
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func documentCommentInputJobCount(t *testing.T, env *testEnv, runID string) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job
		WHERE kind='document.comment_input' AND state<>'scheduled' AND args->>'run_id'=$1`,
		runID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// waitForDocumentCommentInputsIdle waits until the Run's due comment input
// jobs have finished, so the mention's own job cannot be what admits the Run
// after a later save.
func waitForDocumentCommentInputsIdle(t *testing.T, env *testEnv, runID string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var pending bool
		if err := env.pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM river_job
			WHERE kind='document.comment_input' AND args->>'run_id'=$1
			  AND state NOT IN ('scheduled','completed','discarded','cancelled'))`, runID).Scan(&pending); err != nil {
			t.Fatal(err)
		}
		if !pending {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("comment input jobs for Run %s did not finish", runID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// An anchor attachment through the Runtime enqueues the thread's queued Run
// through the Runtime's committed save alone, without the sweep.
func TestCommentAnchorAttachmentAdmitsCommentRunThroughRuntimeSave(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true,
		appOptions:     []appOption{skipping(app.DocumentCommentSweep)},
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	doc, thread, runID := createAgentMentionThread(t, env, alice, "attach-api", suffix)
	waitForDocumentCommentRunQueued(t, env, runID, "suspended")
	waitForDocumentCommentInputsIdle(t, env, runID)
	before := documentCommentInputJobCount(t, env, runID)

	var seq int64
	var fingerprint string
	if err := env.pool.QueryRow(t.Context(), `SELECT seq,encode(sha256(state),'hex')
		FROM document_bodies WHERE document_id=$1`, doc.ID).Scan(&seq, &fingerprint); err != nil {
		t.Fatal(err)
	}
	service := document.NewCommentService(env.pool, documentRuntimeStub{apply: applyToBody(env.pool, func(
		document.ApplyRequest, []byte,
	) ([]byte, []byte, []string, []string, string, error) {
		return []byte{3}, []byte{4}, nil, []string{thread.ID}, "", nil
	})})
	attached, err := service.AttachSelectionAnchor(t.Context(), document.AnchorAttachmentInput{
		AccountID: "account_alice", ThreadID: thread.ID,
		ExpectedPersistedSeq: seq, ExpectedFullStateFingerprint: fingerprint,
	})
	if err != nil || attached.Status != "attached" {
		t.Fatalf("attach Anchor=%+v error=%v", attached, err)
	}
	if after := documentCommentInputJobCount(t, env, runID); after != before+1 {
		t.Fatalf("comment input jobs after the attachment=%d want %d", after, before+1)
	}
	waitForDocumentCommentRunQueued(t, env, runID, "active")
}
