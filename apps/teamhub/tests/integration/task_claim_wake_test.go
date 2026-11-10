package integration_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// listenTaskClaimableHints opens a LISTEN session on the realtime channel.
func listenTaskClaimableHints(t *testing.T, env *testEnv) *pgx.Conn {
	t.Helper()
	listener, err := pgx.Connect(t.Context(), env.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(context.Background()) })
	if _, err := listener.Exec(t.Context(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	return listener
}

// taskClaimableHintsUntilSentinel counts task.claimable notifications up to a
// sentinel NOTIFY. PostgreSQL delivers notifications in commit order, so every
// hint committed before the sentinel is counted.
func taskClaimableHintsUntilSentinel(t *testing.T, env *testEnv, listener *pgx.Conn) int {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), "SELECT pg_notify($1, 'sentinel')", realtime.ChannelName); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	count := 0
	for {
		notification, err := listener.WaitForNotification(ctx)
		if err != nil {
			t.Fatalf("wait for sentinel: %v", err)
		}
		if notification.Payload == "sentinel" {
			return count
		}
		decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
		if err != nil {
			t.Fatalf("decode %s: %v", notification.Payload, err)
		}
		if decoded.Kind == realtime.TaskClaimableKind {
			count++
		}
	}
}

// claimTaskWorkerEmpty claims with nothing claimable and returns the next
// claim delay header, or -1 when TeamHub omits it.
func claimTaskWorkerEmpty(t *testing.T, env *testEnv, workerID string) int64 {
	t.Helper()
	status, headers, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/v0/task-execution-claims",
		teamHubInternalToken, map[string]any{"worker_id": workerID, "lease_seconds": 60})
	if status != http.StatusNoContent {
		t.Fatalf("empty claim status=%d body=%s", status, body)
	}
	value := headers.Get("Task-Next-Claim-Delay-Ms")
	if value == "" {
		return -1
	}
	delay, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		t.Fatalf("delay header=%q", value)
	}
	return delay
}

func expectClaimDelay(t *testing.T, env *testEnv, name string, minimum, maximum int64) {
	t.Helper()
	if delay := claimTaskWorkerEmpty(t, env, "worker-delay-probe"); delay < minimum || delay > maximum {
		t.Fatalf("%s delay=%dms want %d..%d", name, delay, minimum, maximum)
	}
}

// A commit that can make a Task claimable reaches the Agent wake stream as
// task.claimable through the realtime Listener; claims and heartbeats only
// push times later and send nothing. An empty claim reports when the earliest
// pending Task becomes claimable on the database clock.
func TestTaskClaimWakesAndNextClaimDelay(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Task claim wakes", "task-claim-wake-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	if delay := claimTaskWorkerEmpty(t, env, "worker-idle"); delay != -1 {
		t.Fatalf("no pending Task reported delay=%d", delay)
	}
	streamContext, stopStream := context.WithTimeout(t.Context(), 30*time.Second)
	defer stopStream()
	request, _ := http.NewRequestWithContext(streamContext, http.MethodGet, env.server.URL+"/v0/agent-runtime/wakes", nil)
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if record := nextNamedSSE(t, reader); record.Event != "reconcile" {
		t.Fatalf("initial event=%+v", record)
	}
	listener := listenTaskClaimableHints(t, env)

	task := createManagedTaskFixture(t, env, roomID, "claim-wake")
	for {
		record := nextNamedSSE(t, reader)
		if record.Event == realtime.TaskClaimableKind {
			if record.Data != "{}" {
				t.Fatalf("task.claimable data=%s", record.Data)
			}
			break
		}
	}
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count < 1 {
		t.Fatalf("Task creation sent %d task.claimable hints", count)
	}

	bundle := claimTaskWorker(t, env, "worker-claim-wake")
	lease := bundle.Lease
	status, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/v0/task-executions/"+task.ID+"/heartbeat",
		teamHubInternalToken, map[string]any{"worker_id": lease.WorkerID, "lease_generation": lease.LeaseGeneration, "lease_seconds": 60},
		taskLeaseHeader(lease.LeaseToken))
	if status != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", status, body)
	}
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count != 0 {
		t.Fatalf("claim and heartbeat sent %d task.claimable hints", count)
	}
	// The running Task is due but leased: the lease expiry decides.
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_next_reconcile_at=clock_timestamp()-interval '1 second' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	expectClaimDelay(t, env, "lease expiry", 50_000, 60_000)

	// A released lease with a scheduled reconcile: the reconcile time decides.
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_worker_id=NULL,task_lease_token_hash=NULL,task_lease_expires_at=NULL,
		task_next_reconcile_at=clock_timestamp()+interval '20 seconds' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	expectClaimDelay(t, env, "scheduled reconcile", 10_000, 20_000)

	// An idle Task is claimable only through a cleanup effect: a dispatching
	// cleanup's lease decides.
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_execution_status='idle',task_next_reconcile_at=clock_timestamp()-interval '1 second' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if delay := claimTaskWorkerEmpty(t, env, "worker-idle-task"); delay != -1 {
		t.Fatalf("idle Task without cleanup reported delay=%d", delay)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO task_effects(
			id,task_id,tenant_id,generation,root_operation_id,effect_key,operation,owner_id,payload,payload_hash,root_payload_hash,
			dispatch_sequence,status,worker_id,lease_token_hash,lease_generation,lease_expires_at,dispatch_started_at)
		SELECT 'effect_cleanup_wake',id,tenant_id,task_execution_generation,'cleanup-wake','cleanup-wake','cleanup_runtime',id,'{}',
			decode(repeat('ab',32),'hex'),decode(repeat('ab',32),'hex'),1,'dispatching','worker-dead',decode(repeat('cd',32),'hex'),1,
			clock_timestamp()+interval '30 seconds',clock_timestamp()
		FROM work_items WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	expectClaimDelay(t, env, "dispatching cleanup lease", 20_000, 30_000)
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count < 1 {
		t.Fatalf("released lease, earlier reconcile and live cleanup sent %d task.claimable hints", count)
	}
}

// A hint follows only a claimable time, the later of the reconcile time and
// the lease end, that moves earlier. Releasing the lease with a reconcile a
// minute out moves it later, and a Task made due under a lease stays
// claimable only at the lease end until the Worker releases it.
func TestTaskClaimableHintsFollowClaimableTime(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Task claimable time", "task-claimable-time-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	task := createManagedTaskFixture(t, env, roomID, "claimable-time")
	listener := listenTaskClaimableHints(t, env)
	taskClaimableHintsUntilSentinel(t, env, listener)
	queries := store.New(env.pool)

	bundle := claimTaskWorker(t, env, "worker-claimable-later")
	transitionTaskWorker(t, env, bundle, bundle.Lease.WorkerID, bundle.Lease.LeaseToken, bundle.Lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count != 0 {
		t.Fatalf("claim and a later reconcile sent %d task.claimable hints", count)
	}

	if made, err := queries.MakeRunningTaskDue(t.Context(), task.ID); err != nil || made != 1 {
		t.Fatalf("make Task due rows=%d err=%v", made, err)
	}
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count != 1 {
		t.Fatalf("making an unleased Task due sent %d task.claimable hints", count)
	}

	bundle = claimTaskWorker(t, env, "worker-claimable-leased")
	if made, err := queries.MakeRunningTaskDue(t.Context(), task.ID); err != nil || made != 1 {
		t.Fatalf("make leased Task due rows=%d err=%v", made, err)
	}
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count != 0 {
		t.Fatalf("claim and making a leased Task due sent %d task.claimable hints", count)
	}
	transitionTaskWorker(t, env, bundle, bundle.Lease.WorkerID, bundle.Lease.LeaseToken, bundle.Lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count != 1 {
		t.Fatalf("releasing a due Task sent %d task.claimable hints", count)
	}
}

// A quiescent running Task waits at most until its Attempt deadline, so the
// timeout needs no polling.
func TestTaskReconcileIsCappedAtAttemptDeadline(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Task deadline cap", "task-deadline-cap-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	task := createManagedTaskFixture(t, env, roomID, "deadline-cap")
	bundle := claimTaskWorker(t, env, "worker-deadline-cap")
	if bundle.Execution.CurrentAttempt == nil || bundle.Execution.CurrentAttempt.Status != "running" {
		t.Fatalf("claimed Task has no running Attempt: %+v", bundle.Execution.CurrentAttempt)
	}
	var deadline time.Time
	if err := env.pool.QueryRow(t.Context(), `UPDATE task_attempts SET deadline_at=clock_timestamp()+interval '10 seconds'
		WHERE id=$1 RETURNING deadline_at`, bundle.Execution.CurrentAttempt.ID).Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	transitionTaskWorker(t, env, bundle, bundle.Lease.WorkerID, bundle.Lease.LeaseToken, bundle.Lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	var next time.Time
	if err := env.pool.QueryRow(t.Context(), `SELECT task_next_reconcile_at FROM work_items WHERE id=$1`, task.ID).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if !next.Equal(deadline) {
		t.Fatalf("next reconcile=%s want Attempt deadline %s", next, deadline)
	}
	expectClaimDelay(t, env, "Attempt deadline", 1, 10_000)
}

// participantRunTask is a running managed Task whose lease the Worker released
// with a one-minute safety net, plus its participant Context.
type participantRunTask struct {
	task       managedTaskFixture
	contextKey string
	service    *agentruntimestate.Service
	epoch      string
}

func newParticipantRunTask(t *testing.T, env *testEnv, alice *http.Client, suffix string) participantRunTask {
	t.Helper()
	roomID := createPrivateRoom(t, env, alice, "Participant Run "+suffix, "participant-run-room-"+suffix)
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	task := createManagedTaskFixture(t, env, roomID, suffix)
	bundle := claimTaskWorker(t, env, "worker-"+suffix)
	transitionTaskWorker(t, env, bundle, bundle.Lease.WorkerID, bundle.Lease.LeaseToken, bundle.Lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	service := agentruntimestate.New(env.pool)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "active",
		Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: acmeOfficialAgentManagementID, TaskID: task.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	epoch := "epoch-" + suffix
	startRuntimeEpoch(t, service, epoch)
	return participantRunTask{task: task, contextKey: ensured.Context.ContextKey, service: service, epoch: epoch}
}

// startRun seeds a Run that the epoch's Agent Service holds.
func (p participantRunTask) startRun(t *testing.T, env *testEnv, runID string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at,epoch,claim_id)
		VALUES($1,$2,'running',clock_timestamp(),$3,$1)`, runID, p.contextKey, p.epoch); err != nil {
		t.Fatal(err)
	}
}

func (p participantRunTask) finishRun(ctx context.Context, runID string) error {
	_, err := p.service.FinishLocalRun(ctx, agentruntimestate.FinishLocalRunInput{
		ContextKey: p.contextKey, Epoch: p.epoch, RunID: runID, Terminal: json.RawMessage(`{"type":"succeeded"}`),
	})
	return err
}

func participantRunJobs(t *testing.T, env *testEnv) int {
	t.Helper()
	return countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='task_execution.participant_run_finished'`)
}

// A participant Run finishing enqueues a River job in its own transaction and
// notifies River, so the job makes the running Task due without polling and
// the Task Worker hears task.claimable.
func TestParticipantRunTerminalMakesRunningTaskClaimable(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t, starting(app.JobQueue))
	participant := newParticipantRunTask(t, env, alice, "run-terminal")
	participant.startRun(t, env, "participant-run-terminal")
	if delay := claimTaskWorkerEmpty(t, env, "worker-before-finish"); delay < 50_000 {
		t.Fatalf("quiescent Task delay=%dms, want the safety net", delay)
	}

	riverListener, err := pgx.Connect(t.Context(), env.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = riverListener.Close(context.Background()) })
	if _, err := riverListener.Exec(t.Context(), `LISTEN "public.river_insert"`); err != nil {
		t.Fatal(err)
	}
	streamContext, stopStream := context.WithTimeout(t.Context(), 30*time.Second)
	defer stopStream()
	request, _ := http.NewRequestWithContext(streamContext, http.MethodGet, env.server.URL+"/v0/agent-runtime/wakes", nil)
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	if record := nextNamedSSE(t, reader); record.Event != "reconcile" {
		t.Fatalf("initial event=%+v", record)
	}

	started := time.Now()
	if err := participant.finishRun(t.Context(), "participant-run-terminal"); err != nil {
		t.Fatal(err)
	}
	waitContext, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	notification, err := riverListener.WaitForNotification(waitContext)
	if err != nil || notification.Payload != `{"queue" : "default"}` {
		t.Fatalf("River insert notification=%+v err=%v", notification, err)
	}
	for {
		if record := nextNamedSSE(t, reader); record.Event == realtime.TaskClaimableKind {
			break
		}
	}
	t.Logf("participant Run terminal -> task.claimable elapsed=%s", time.Since(started))
	bundle := claimTaskWorker(t, env, "worker-after-finish")
	if bundle.Execution.TaskID != participant.task.ID {
		t.Fatalf("claimed Task %s, want %s", bundle.Execution.TaskID, participant.task.ID)
	}
	if jobs := participantRunJobs(t, env); jobs != 1 {
		t.Fatalf("participant Run jobs=%d want=1", jobs)
	}
}

// A Run of a Context that is not a Task participant enqueues nothing.
func TestNonTaskRunTerminalEnqueuesNoTaskJob(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at,epoch,claim_id)
		VALUES('meta-run-terminal',$1,'running',clock_timestamp(),$2,'meta-run-terminal')`, env.contextKey, env.epoch); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: "meta-run-terminal", Terminal: json.RawMessage(`{"type":"succeeded"}`),
	}); err != nil {
		t.Fatal(err)
	}
	var jobs int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM river_job WHERE kind='task_execution.participant_run_finished'`).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 {
		t.Fatalf("Meta Run terminal enqueued %d Task jobs", jobs)
	}
}

// A waiting job can run before a concurrent Run commits and still see that
// Run running, so every terminal Run enqueues its own job.
func TestParticipantRunsTerminalEachEnqueueTaskJob(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	participant := newParticipantRunTask(t, env, alice, "runs-terminal")
	participant.startRun(t, env, "participant-runs-terminal-a")
	if err := participant.finishRun(t.Context(), "participant-runs-terminal-a"); err != nil {
		t.Fatal(err)
	}
	if available := countRows(t, env, `SELECT count(*) FROM river_job
		WHERE kind='task_execution.participant_run_finished' AND state='available'`); available != 1 {
		t.Fatalf("available participant Run jobs after the first Run=%d want=1", available)
	}
	participant.startRun(t, env, "participant-runs-terminal-b")
	if err := participant.finishRun(t.Context(), "participant-runs-terminal-b"); err != nil {
		t.Fatal(err)
	}
	if jobs := participantRunJobs(t, env); jobs != 2 {
		t.Fatalf("participant Run jobs=%d want=2", jobs)
	}
}

// Archive locks the Task row, then the participant Context and its Runs;
// finishing a Run locks the Context and Run first. The Run's trigger only
// enqueues a job, so racing them never deadlocks.
func TestTaskArchiveAndParticipantRunFinishDoNotDeadlock(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	participant := newParticipantRunTask(t, env, alice, "archive-race")
	archived := false
	for iteration := range 40 {
		runID := "archive-race-run-" + strconv.Itoa(iteration)
		participant.startRun(t, env, runID)
		var version int64
		if err := env.pool.QueryRow(t.Context(), `SELECT version FROM work_items WHERE id=$1`, participant.task.ID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		action := "archive"
		if archived {
			action = "unarchive"
		}
		var group sync.WaitGroup
		var archiveStatus int
		var archiveBody []byte
		var finishErr error
		start := make(chan struct{})
		group.Go(func() {
			<-start
			archiveStatus, _, archiveBody = env.request(alice, http.MethodPost, "/v0/work-items/"+participant.task.ID+"/"+action,
				map[string]any{"expected_version": version}, "archive-race-"+strconv.Itoa(iteration))
		})
		group.Go(func() {
			<-start
			finishErr = participant.finishRun(t.Context(), runID)
		})
		close(start)
		group.Wait()
		if archiveStatus != http.StatusOK {
			t.Fatalf("iteration %d %s status=%d body=%s", iteration, action, archiveStatus, archiveBody)
		}
		var pgErr *pgconn.PgError
		if errors.As(finishErr, &pgErr) {
			t.Fatalf("iteration %d finish failed in PostgreSQL: %v", iteration, finishErr)
		}
		if finishErr != nil && !errors.Is(finishErr, agentruntimestate.ErrConflict) && !errors.Is(finishErr, agentruntimestate.ErrFenced) {
			t.Fatalf("iteration %d finish: %v", iteration, finishErr)
		}
		archived = !archived
	}
}

// A participant Run can finish while the Worker drives its Task under the
// lease. The job makes the Task due without the lease; the Worker's later
// schedule_reconcile, decided on the earlier observation, must keep it due
// instead of pushing it a minute out, even after a heartbeat.
func TestScheduleReconcileKeepsTaskMadeDueDuringLease(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Task due during lease", "task-due-during-lease-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	task := createManagedTaskFixture(t, env, roomID, "due-during-lease")
	bundle := claimTaskWorker(t, env, "worker-due-during-lease")
	listener := listenTaskClaimableHints(t, env)
	if made, err := store.New(env.pool).MakeRunningTaskDue(t.Context(), task.ID); err != nil || made != 1 {
		t.Fatalf("make Task due rows=%d err=%v", made, err)
	}
	// A heartbeat between the writer and the schedule keeps the Task due.
	status, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/v0/task-executions/"+task.ID+"/heartbeat",
		teamHubInternalToken, map[string]any{"worker_id": bundle.Lease.WorkerID, "lease_generation": bundle.Lease.LeaseGeneration, "lease_seconds": 60},
		taskLeaseHeader(bundle.Lease.LeaseToken))
	if status != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", status, body)
	}
	transitionTaskWorker(t, env, bundle, bundle.Lease.WorkerID, bundle.Lease.LeaseToken, bundle.Lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	if count := taskClaimableHintsUntilSentinel(t, env, listener); count < 1 {
		t.Fatalf("releasing a due Task sent %d task.claimable hints", count)
	}
	if again := claimTaskWorker(t, env, "worker-after-due"); again.Execution.TaskID != task.ID {
		t.Fatalf("claimed Task %s, want %s", again.Execution.TaskID, task.ID)
	}
}

// A drive can outlast the claim's lease. The heartbeat moves the reconcile
// time with the lease, so the Worker's later schedule_reconcile is not
// mistaken for a Task made due during the lease. The API's lease minimum is
// five seconds, so the claim's one-second lease is set on the row.
func TestScheduleReconcileAfterHeartbeatOutlastsClaimLease(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Task lease outlasted", "task-lease-outlasted-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	task := createManagedTaskFixture(t, env, roomID, "lease-outlasted")
	bundle := claimTaskWorker(t, env, "worker-lease-outlasted")
	lease := bundle.Lease
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_items SET task_lease_expires_at=clock_timestamp()+interval '1 second',
		task_next_reconcile_at=clock_timestamp()+interval '1 second' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	status, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/v0/task-executions/"+task.ID+"/heartbeat",
		teamHubInternalToken, map[string]any{"worker_id": lease.WorkerID, "lease_generation": lease.LeaseGeneration, "lease_seconds": 5},
		taskLeaseHeader(lease.LeaseToken))
	if status != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", status, body)
	}
	time.Sleep(1200 * time.Millisecond)
	transitionTaskWorker(t, env, bundle, lease.WorkerID, lease.LeaseToken, lease.LeaseGeneration,
		"schedule_reconcile", map[string]any{"reconcile_after_seconds": 60})
	var dueIn float64
	if err := env.pool.QueryRow(t.Context(), `SELECT extract(epoch FROM task_next_reconcile_at-clock_timestamp())::float8 FROM work_items WHERE id=$1`,
		task.ID).Scan(&dueIn); err != nil {
		t.Fatal(err)
	}
	if dueIn < 50 || dueIn > 60 {
		t.Fatalf("reconcile due in %.1fs, want about 60s", dueIn)
	}
}
