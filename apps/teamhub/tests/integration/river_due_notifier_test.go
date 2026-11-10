package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

// dueProbeArgs names a probe job; mode decides what its first attempt does.
type dueProbeArgs struct {
	Name string `json:"name"`
	Mode string `json:"mode"`
}

func (dueProbeArgs) Kind() string { return "test.due_probe" }

type dueProbeRun struct {
	id      int64
	name    string
	attempt int
	at      time.Time
}

type dueProbeWorker struct {
	river.WorkerDefaults[dueProbeArgs]
	runs     chan dueProbeRun
	mu       sync.Mutex
	attempts map[string]int
}

func (w *dueProbeWorker) Work(_ context.Context, job *river.Job[dueProbeArgs]) error {
	w.mu.Lock()
	w.attempts[job.Args.Name]++
	attempt := w.attempts[job.Args.Name]
	w.mu.Unlock()
	w.runs <- dueProbeRun{id: job.ID, name: job.Args.Name, attempt: attempt, at: time.Now()}
	if attempt == 1 {
		switch job.Args.Mode {
		case "snooze":
			return river.JobSnooze(time.Second)
		case "error":
			return errors.New("probe failure")
		}
	}
	return nil
}

// NextRetry keeps the retry within River's scheduler horizon, where River
// writes it available with a future due time and no notification.
func (w *dueProbeWorker) NextRetry(*river.Job[dueProbeArgs]) time.Time {
	return time.Now().Add(time.Second)
}

type dueHarness struct {
	pool   *pgxpool.Pool
	worker *dueProbeWorker
	steps  atomic.Int64
}

// startDueHarness runs a River client whose queues poll once an hour, so a
// prompt job proves a notification reached it, beside the due notifier and
// the realtime Listener that wakes it.
func startDueHarness(t *testing.T) *dueHarness {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h := &dueHarness{pool: pool, worker: &dueProbeWorker{runs: make(chan dueProbeRun, 16), attempts: map[string]int{}}}
	broker := realtime.NewBroker(4)
	listener, err := realtime.NewListener(pool.Config().ConnString(), broker, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(listener.Close)
	workers := river.NewWorkers()
	river.AddWorker(workers, h.worker)
	options := jobs.Options{Workers: workers, PollInterval: time.Hour, TestOnly: true}
	notifier := jobs.NewDueNotifier(pool, options, func() { h.steps.Add(1) })
	broker.SetWorkWake(realtime.WorkRiverDueTopic, notifier.Wake)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		notifier.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	client, err := jobs.NewClient(pool, options)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})
	// The first step notifies every queue, so a recheck follows it.
	h.waitSteps(t, 2)
	h.waitRiverListening(t)
	return h
}

// waitRiverListening returns once River has fetched a job on its insert
// notification. Client.Start returns before River's LISTEN is active, and a
// notification sent before then is lost to the hour-long poll.
func (h *dueHarness) waitRiverListening(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		// Maintenance inserts do not wake the notifier, so its steps stay
		// countable.
		h.insert(t, dueProbeArgs{Name: "warmup"}, &river.InsertOpts{Queue: jobs.QueueMaintenance})
		select {
		case <-h.worker.runs:
			for {
				select {
				case <-h.worker.runs:
				case <-time.After(300 * time.Millisecond):
					return
				}
			}
		case <-time.After(250 * time.Millisecond):
		}
	}
	t.Fatal("River did not fetch on its insert notification")
}

func (h *dueHarness) insert(t *testing.T, args dueProbeArgs, opts *river.InsertOpts) {
	t.Helper()
	if err := pgx.BeginFunc(t.Context(), h.pool, func(tx pgx.Tx) error {
		return jobs.InsertTx(t.Context(), tx, args, opts)
	}); err != nil {
		t.Fatal(err)
	}
}

func (h *dueHarness) nextRun(t *testing.T) dueProbeRun {
	t.Helper()
	timeout := time.After(30 * time.Second)
	for {
		select {
		case run := <-h.worker.runs:
			// A warmup the harness retried can run late; it is no probe.
			if run.name == "warmup" {
				continue
			}
			return run
		case <-timeout:
			t.Fatal("probe job did not run")
			return dueProbeRun{}
		}
	}
}

func (h *dueHarness) waitSteps(t *testing.T, want int64) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for h.steps.Load() < want {
		if time.Now().After(deadline) {
			t.Fatalf("notifier steps=%d want>=%d", h.steps.Load(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// assertRanOnTime checks job id's latest attempt on the database clock:
// River's fetch sets attempted_at from the database's now() and takes only jobs
// whose scheduled_at has passed on that clock. River computes a snooze or retry
// time, and its scheduler's look-ahead, on the Go clock, so a database clock
// ahead of the Go clock makes such a job due, and run, that much later;
// that skew is allowed on top of the second.
func (h *dueHarness) assertRanOnTime(t *testing.T, what string, id int64) {
	t.Helper()
	var scheduledAt, attemptedAt, dbNow time.Time
	if err := h.pool.QueryRow(t.Context(), `SELECT scheduled_at, attempted_at, now() FROM river_job WHERE id=$1`, id).
		Scan(&scheduledAt, &attemptedAt, &dbNow); err != nil {
		t.Fatal(err)
	}
	skew := max(-time.Since(dbNow), 0)
	if late := attemptedAt.Sub(scheduledAt); late < 0 || late > time.Second+skew {
		t.Fatalf("%s attempted %s after its due time (database ahead of Go by %s)", what, late, skew)
	}
}

// assertPrompt fails when got is more than a second after due.
func assertPrompt(t *testing.T, what string, due, got time.Time) {
	t.Helper()
	if late := got.Sub(due); late > time.Second {
		t.Fatalf("%s ran %s after its due time", what, late)
	}
}

func TestRiverDueNotifierRunsJobsAtTheirDueTime(t *testing.T) {
	serialIntegrationTest(t, serialWallClockBound)
	for _, queue := range []string{jobs.QueueDefault, jobs.QueueSchedule} {
		t.Run("a scheduled job runs at its time on "+queue, func(t *testing.T) {
			h := startDueHarness(t)
			// River's scheduler moves a job to available once it is due within its
			// five-second look-ahead, so this job has been moved before it is due.
			// The due time comes from the database clock, which River's fetch uses.
			var dbNow time.Time
			if err := h.pool.QueryRow(t.Context(), `SELECT now()`).Scan(&dbNow); err != nil {
				t.Fatal(err)
			}
			h.insert(t, dueProbeArgs{Name: "scheduled"}, &river.InsertOpts{Queue: queue, ScheduledAt: dbNow.Add(6 * time.Second)})
			h.assertRanOnTime(t, "scheduled job", h.nextRun(t).id)
		})
	}
	t.Run("comment input jobs run at once", func(t *testing.T) {
		h := startDueHarness(t)
		inserted := time.Now()
		h.insert(t, dueProbeArgs{Name: "river-insert"}, &river.InsertOpts{Queue: jobs.QueueDocumentInput})
		assertPrompt(t, "inserted comment input", inserted, h.nextRun(t).at)
		// TeamHub's SQL inserts comment input jobs itself and notifies the queue.
		inserted = time.Now()
		if _, err := h.pool.Exec(t.Context(), `WITH job AS (
			INSERT INTO river_job(kind, queue, args, max_attempts)
			VALUES ('test.due_probe', 'document_input', '{"name":"sql-insert"}', 1) RETURNING id)
			SELECT notify_river_queue('document_input') FROM job`); err != nil {
			t.Fatal(err)
		}
		assertPrompt(t, "SQL comment input", inserted, h.nextRun(t).at)
	})
	t.Run("a snoozed job runs again when its snooze ends", func(t *testing.T) {
		h := startDueHarness(t)
		h.insert(t, dueProbeArgs{Name: "snooze", Mode: "snooze"}, nil)
		first := h.nextRun(t)
		second := h.nextRun(t)
		if second.attempt != 2 {
			t.Fatalf("second run attempt=%d", second.attempt)
		}
		if second.id != first.id {
			t.Fatalf("second run is job %d, want %d", second.id, first.id)
		}
		h.assertRanOnTime(t, "snoozed job", second.id)
	})
	t.Run("a failed job runs its short retry on time", func(t *testing.T) {
		h := startDueHarness(t)
		h.insert(t, dueProbeArgs{Name: "error", Mode: "error"}, nil)
		first := h.nextRun(t)
		second := h.nextRun(t)
		if second.attempt != 2 {
			t.Fatalf("retry attempt=%d", second.attempt)
		}
		if second.id != first.id {
			t.Fatalf("second run is job %d, want %d", second.id, first.id)
		}
		h.assertRanOnTime(t, "retried job", second.id)
	})
	t.Run("a Listener reconnect notifies every queue", func(t *testing.T) {
		h := startDueHarness(t)
		conn, err := pgx.Connect(t.Context(), h.pool.Config().ConnString())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close(context.Background())
		if _, err := conn.Exec(t.Context(), `LISTEN "public.river_insert"`); err != nil {
			t.Fatal(err)
		}
		missing := map[string]bool{}
		for _, queue := range []string{jobs.QueueDefault, jobs.QueueMaintenance, jobs.QueueIndexing, jobs.QueuePersonalWiki,
			jobs.QueueGeneration, jobs.QueueSchedule, jobs.QueueExternal, jobs.QueueDocumentInput} {
			missing[queue] = true
		}
		terminateRealtimeListeners(t, h.pool)
		waitCtx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		defer cancel()
		for len(missing) > 0 {
			notification, err := conn.WaitForNotification(waitCtx)
			if err != nil {
				t.Fatalf("queues not notified after reconnect: %v (%v)", missing, err)
			}
			var payload struct {
				Queue string `json:"queue"`
			}
			if err := json.Unmarshal([]byte(notification.Payload), &payload); err != nil {
				t.Fatal(err)
			}
			delete(missing, payload.Queue)
		}
	})
	t.Run("maintenance jobs inserted due now do not wake the notifier", func(t *testing.T) {
		h := startDueHarness(t)
		before := h.steps.Load()
		// Whether River fetches them at once is River's own notification,
		// which can be lost here and is left to the poll by design.
		for _, name := range []string{"now-1", "now-2", "now-3"} {
			h.insert(t, dueProbeArgs{Name: name}, &river.InsertOpts{Queue: jobs.QueueMaintenance})
		}
		time.Sleep(time.Second)
		if steps := h.steps.Load(); steps != before {
			t.Fatalf("notifier stepped %d times for due-now maintenance inserts", steps-before)
		}
	})
}

func TestEnqueueDocumentTextSyncNotifiesIndexing(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	conn, err := pgx.Connect(t.Context(), pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(t.Context(), `LISTEN "public.river_insert"`); err != nil {
		t.Fatal(err)
	}
	enqueue := func() {
		t.Helper()
		if _, err := pool.Exec(t.Context(), `SELECT enqueue_document_text_sync('document_due_probe')`); err != nil {
			t.Fatal(err)
		}
	}
	enqueue()
	waitCtx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	notification, err := conn.WaitForNotification(waitCtx)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Queue string `json:"queue"`
	}
	if err := json.Unmarshal([]byte(notification.Payload), &payload); err != nil || payload.Queue != jobs.QueueIndexing {
		t.Fatalf("notification=%q err=%v", notification.Payload, err)
	}
	// A job already queued for the Document absorbs the call and sends nothing.
	enqueue()
	quietCtx, quietCancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer quietCancel()
	if notification, err := conn.WaitForNotification(quietCtx); err == nil {
		t.Fatalf("duplicate enqueue notified %q", notification.Payload)
	}
}

// No River client runs here, so notified jobs stay available, as when River's
// producer loses a notification.
func TestRiverDueNotifierRechecksRecentlyDueJobs(t *testing.T) {
	serialIntegrationTest(t, serialWallClockBound)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	conn, err := pgx.Connect(t.Context(), pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(t.Context(), `LISTEN "public.river_insert"`); err != nil {
		t.Fatal(err)
	}
	broker := realtime.NewBroker(4)
	listener, err := realtime.NewListener(pool.Config().ConnString(), broker, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var steps atomic.Int64
	notifier := jobs.NewDueNotifier(pool, jobs.Options{}, func() { steps.Add(1) })
	broker.SetWorkWake(realtime.WorkRiverDueTopic, notifier.Wake)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		notifier.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	type notified struct {
		queue string
		at    time.Duration
	}
	var start time.Time
	listen := func(d time.Duration) []notified {
		listenCtx, listenCancel := context.WithTimeout(t.Context(), d)
		defer listenCancel()
		var got []notified
		for {
			notification, err := conn.WaitForNotification(listenCtx)
			if err != nil {
				return got
			}
			var payload struct {
				Queue string `json:"queue"`
			}
			if err := json.Unmarshal([]byte(notification.Payload), &payload); err != nil {
				t.Fatal(err)
			}
			got = append(got, notified{payload.Queue, time.Since(start)})
		}
	}
	// The first step notifies every configured queue; its recheck follows.
	start = time.Now()
	queues := map[string]bool{}
	for _, n := range listen(3 * time.Second) {
		queues[n.queue] = true
	}
	if !queues[jobs.QueueDefault] || !queues[jobs.QueueMaintenance] || !queues[jobs.QueueDocumentInput] {
		t.Fatalf("startup notified %v, want every queue", queues)
	}
	// A plain insert sends no River notification, as if River lost it.
	start = time.Now()
	if _, err := pool.Exec(t.Context(), `INSERT INTO river_job(kind, queue, args, scheduled_at) VALUES
		('test.due_probe', 'default', '{}', now()),
		('test.due_probe', 'probe_old', '{}', now() - interval '1 minute')`); err != nil {
		t.Fatal(err)
	}
	var recent, old []time.Duration
	for _, n := range listen(15 * time.Second) {
		switch n.queue {
		case jobs.QueueDefault:
			recent = append(recent, n.at)
		case "probe_old":
			old = append(old, n.at)
		}
	}
	if len(old) != 1 || old[0] > time.Second {
		t.Fatalf("old job notified at %v, want only by the woken step", old)
	}
	if len(recent) < 4 || recent[0] > time.Second {
		t.Fatalf("due-now job notified at %v, want the woken step and rechecks", recent)
	}
	for i := 1; i < len(recent); i++ {
		if gap := recent[i] - recent[i-1]; gap > 2500*time.Millisecond {
			t.Fatalf("due-now job notified at %v, recheck gap %s", recent, gap)
		}
	}
	if last := recent[len(recent)-1]; last > 13*time.Second {
		t.Fatalf("due-now job notified at %v, still rechecked after its window", recent)
	}
	// Once its window passes, the notifier sleeps again.
	settled := steps.Load()
	time.Sleep(2500 * time.Millisecond)
	if steps.Load() != settled {
		t.Fatal("notifier kept stepping after the recheck window")
	}
}

// Every job insert, snooze, or retry wakes the notifier, so a burst of wakes
// must cost a few spaced steps rather than one step per wake.
func TestRiverDueNotifierSpacesWokenSteps(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var steps atomic.Int64
	notifier := jobs.NewDueNotifier(pool, jobs.Options{Workers: river.NewWorkers(), TestOnly: true}, func() { steps.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		notifier.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	for steps.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	start := steps.Load()
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		notifier.Wake(false)
		time.Sleep(100 * time.Microsecond)
	}
	if got, limit := steps.Load()-start, int64(time.Second/(250*time.Millisecond)+2); got > limit {
		t.Fatalf("woken steps=%d want<=%d", got, limit)
	}
}

// A running job finishing outside the maintenance queue wakes a normal step,
// which renotifies any due backlog River's producer may have dropped; a
// finished maintenance sweep wakes nothing.
func TestRiverDueNotifierStepsWhenJobFinishes(t *testing.T) {
	allowParallelIntegrationTest(t)
	pool, err := pgxpool.New(t.Context(), newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	broker := realtime.NewBroker(4)
	listener, err := realtime.NewListener(pool.Config().ConnString(), broker, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(listener.Close)
	var steps atomic.Int64
	notifier := jobs.NewDueNotifier(pool, jobs.Options{Workers: river.NewWorkers(), TestOnly: true}, func() { steps.Add(1) })
	broker.SetWorkWake(realtime.WorkRiverDueTopic, notifier.Wake)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		notifier.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	var maintenanceID, defaultID int64
	if err := pool.QueryRow(t.Context(), `INSERT INTO river_job(kind, queue, args, state, attempt, attempted_at)
		VALUES ('test.due_probe', $1, '{}', 'running', 1, now()) RETURNING id`, jobs.QueueMaintenance).Scan(&maintenanceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `INSERT INTO river_job(kind, queue, args, state, attempt, attempted_at)
		VALUES ('test.due_probe', $1, '{}', 'running', 1, now()) RETURNING id`, jobs.QueueDefault).Scan(&defaultID); err != nil {
		t.Fatal(err)
	}
	// The startup step notifies every queue and its recheck follows; wait
	// until the notifier sleeps.
	settled := func() int64 {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			before := steps.Load()
			time.Sleep(2500 * time.Millisecond)
			if after := steps.Load(); after == before && after > 0 {
				return after
			}
			if time.Now().After(deadline) {
				t.Fatal("notifier did not settle")
			}
		}
	}
	finish := func(id int64) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), `UPDATE river_job SET state='completed', finalized_at=now() WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	idle := settled()
	finish(maintenanceID)
	time.Sleep(time.Second)
	if got := steps.Load(); got != idle {
		t.Fatalf("finished maintenance job ran %d notifier steps", got-idle)
	}
	finish(defaultID)
	deadline := time.Now().Add(30 * time.Second)
	for steps.Load() == idle {
		if time.Now().After(deadline) {
			t.Fatal("finished default job ran no notifier step")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
