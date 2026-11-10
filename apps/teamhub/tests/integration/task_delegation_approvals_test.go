package integration_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// An AlterEgo's approval card expires after 10 minutes, and expiring wakes the
// AlterEgo like a decision; stopping the Task expires its cards without a
// wake.
func TestAlterEgoApprovalCardsExpireOrStopWithTheTask(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	cards := typedcard.New(env.pool)

	t.Run("an expired card wakes the AlterEgo", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "card-expiry", "Send the quote", "Send the quote.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-card-expiry")
		effectID := worker.startTurn("run-card-expiry")
		contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-card-expiry", "Waiting for approval.")
		insertPendingRuntimePermission(t, env, roomID, contextKey, "decision_card_expiry")
		worker.endTurn(effectID, "run-card-expiry", "succeeded", "")
		worker.advance()
		assertDelegatedTaskState(t, env, created.TaskID, "waiting_for_approval", "pending_approval")

		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp() WHERE id='decision_card_expiry'`); err != nil {
			t.Fatal(err)
		}
		expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_expiry")
		if err != nil || !expired {
			t.Fatalf("expired=%v err=%v", expired, err)
		}
		// The AlterEgo is woken through decision.run, after the expiry commits.
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_expiry'`); got != 1 {
			t.Fatalf("expiry wake jobs=%d want=1", got)
		}
		// The expiry is a result: the AlterEgo is told as for a decision.
		notice, err := cards.HandOffDecision(t.Context(), "decision_card_expiry")
		if err != nil || notice.AlterEgoTaskID != created.TaskID || !strings.Contains(notice.Text, "Approval decision_card_expiry expired") {
			t.Fatalf("expiry notice=%+v err=%v", notice, err)
		}
		// An expired card no longer holds the Task waiting.
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE alter_ego_task_id=$1 AND status='pending'`, created.TaskID); got != 0 {
			t.Fatalf("pending approvals after expiry=%d", got)
		}
		// A retried expiry job wakes nobody again.
		if expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_expiry"); err != nil || expired {
			t.Fatalf("second expiry=%v err=%v", expired, err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_expiry'`); got != 1 {
			t.Fatalf("expiry wake jobs after a retry=%d want=1", got)
		}
	})

	t.Run("stopping expires the cards without a wake", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "card-stop", "Book the room", "Book the meeting room.", roomID)
		contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-card-stop", "Waiting.")
		insertPendingRuntimePermission(t, env, roomID, contextKey, "decision_card_stop")
		stopDelegatedTask(t, env, issued, roomID, "card-stop-stop", created.TaskID)
		assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='task_delegation.expire_stopped_approvals'
			AND args->>'task_id'=$1`, created.TaskID); got != 1 {
			t.Fatalf("stop expiry jobs=%d want=1", got)
		}
		if err := cards.ExpireStoppedTaskApprovals(t.Context(), acmeTenant, created.TaskID); err != nil {
			t.Fatal(err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id='decision_card_stop' AND status='expired'`); got != 1 {
			t.Fatalf("stopped Task's expired cards=%d want=1", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_stop'`); got != 0 {
			t.Fatalf("a stopped Task's card woke the AlterEgo: %d jobs", got)
		}
		// The card's own expiry job, due later, still wakes nobody.
		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp() WHERE id='decision_card_stop'`); err != nil {
			t.Fatal(err)
		}
		if expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_stop"); err != nil || expired {
			t.Fatalf("expiry job after stop expired=%v err=%v", expired, err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_stop'`); got != 0 {
			t.Fatalf("the expiry job woke a stopped Task: %d jobs", got)
		}
	})
}

func stopDelegatedTask(t *testing.T, env *testEnv, issued agentcredential.Issued, roomID, invocation, taskID string) {
	t.Helper()
	code, body := postTaskCommand(t, env, issued, "stop", map[string]any{
		"invocation_id": mcpCreationInvocationID(invocation), "task_id": taskID,
	}, taskDelegationRoomContext(roomID))
	if code != http.StatusOK {
		t.Fatalf("task stop=%d %s", code, body)
	}
}
