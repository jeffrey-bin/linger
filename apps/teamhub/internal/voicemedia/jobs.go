package voicemedia

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Background voice work is one River job per voice session or Capture and per
// kind of work. A step does what is due, then reports when the key needs
// another step; a commit that makes work due wakes the key's job, so nothing
// scans for work while voice is idle.

const (
	// JobDone ends a job: its key has no work left of this kind.
	JobDone time.Duration = -1
	// jobRecheckWait keeps a step whose due work another write moved from
	// running in a tight loop.
	jobRecheckWait = 250 * time.Millisecond
	// jobErrorWait spaces the steps of a key whose work keeps failing.
	jobErrorWait = 5 * time.Second
	// noJobTimeout leaves a job's deadline to its step.
	noJobTimeout time.Duration = -1
)

// Voice jobs run on their own queues, which exist only in a TeamHub that
// registers voice workers, so a TeamHub without voice polls none of them.
const (
	// QueueVoice runs the short voice jobs: session and recording
	// reconciliation, recorder stop, recording completion, staging cleanup.
	QueueVoice = "voice"
	// QueueVoiceMedia runs recording materialization, which takes minutes,
	// apart from the voice jobs a stop waits on.
	QueueVoiceMedia = "voice_media"
	// QueueVoiceRecovery runs archive transcript recovery one Capture at a
	// time, so a long recovery never holds a materialization slot.
	QueueVoiceRecovery = "voice_recovery"
)

var voiceQueues = map[string]river.QueueConfig{
	QueueVoice:         {MaxWorkers: 8},
	QueueVoiceMedia:    {MaxWorkers: 4},
	QueueVoiceRecovery: {MaxWorkers: 1},
}

// VoiceSessionReconcileArgs keeps one open voice session's provider room and
// publisher in step with its row until the session closes.
type VoiceSessionReconcileArgs struct {
	VoiceSessionID string `json:"voice_session_id"`
}

// Kind names the River job kind.
func (VoiceSessionReconcileArgs) Kind() string { return "voice_session_reconcile" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (VoiceSessionReconcileArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoice, UniqueOpts: jobs.UniqueUnfinished}
}

// CaptureReconcileArgs observes a Capture's recorders until the Capture stops
// recording.
type CaptureReconcileArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (CaptureReconcileArgs) Kind() string { return "voice_capture_reconcile" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (CaptureReconcileArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoice, UniqueOpts: jobs.UniqueUnfinished}
}

// CaptureStopArgs stops a stopped Capture's last recorder.
type CaptureStopArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (CaptureStopArgs) Kind() string { return "voice_capture_stop" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (CaptureStopArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoice, UniqueOpts: jobs.UniqueUnfinished}
}

// CaptureMaterializeArgs saves a stopped Capture's final audio.
type CaptureMaterializeArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (CaptureMaterializeArgs) Kind() string { return "voice_capture_materialize" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (CaptureMaterializeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoiceMedia, UniqueOpts: jobs.UniqueUnfinished}
}

// TranscriptRecoveryArgs transcribes a Capture's archive again when its live
// transcript is incomplete.
type TranscriptRecoveryArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (TranscriptRecoveryArgs) Kind() string { return "voice_transcript_recovery" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (TranscriptRecoveryArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoiceRecovery, UniqueOpts: jobs.UniqueUnfinished}
}

// CaptureCompletionArgs writes a finalized Capture's transcript Document and
// completion message. TeamHub's app layer works it.
type CaptureCompletionArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (CaptureCompletionArgs) Kind() string { return "voice_capture_completion" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (CaptureCompletionArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoice, UniqueOpts: jobs.UniqueUnfinished}
}

// StagingCleanupArgs deletes an ended Capture's recorder staging.
type StagingCleanupArgs struct {
	CaptureSessionID string `json:"capture_session_id"`
}

// Kind names the River job kind.
func (StagingCleanupArgs) Kind() string { return "voice_staging_cleanup" }

// InsertOpts keeps one unfinished job per key on its voice queue.
func (StagingCleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueVoice, UniqueOpts: jobs.UniqueUnfinished}
}

// enqueue inserts each job in tx, or wakes the key's waiting job, so the work
// becomes visible exactly when the fact that requires it commits.
func enqueue(ctx context.Context, tx pgx.Tx, args ...river.JobArgs) error {
	for _, job := range args {
		if err := jobs.InsertOrWakeTx(ctx, tx, job, nil); err != nil {
			return err
		}
	}
	return nil
}

// wake enqueues jobs for an outcome that is not a database write, such as a
// provider call that returned.
func (s *Service) wake(ctx context.Context, args ...river.JobArgs) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return enqueue(ctx, tx, args...) })
}

// WakeMaterialization wakes a stopped Capture's materialization after its
// transcript coverage advanced.
func (s *Service) WakeMaterialization(ctx context.Context, captureID string) error {
	return s.wake(ctx, CaptureMaterializeArgs{CaptureSessionID: captureID})
}

// RetryTranscriptRecovery makes a failed archive transcript recovery due again.
// It reports pgx.ErrNoRows when the account cannot retry the Capture's recovery.
func (s *Service) RetryTranscriptRecovery(ctx context.Context, accountID, captureID string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := s.queries.WithTx(tx).RetryVoiceTranscriptRecovery(ctx, store.RetryVoiceTranscriptRecoveryParams{
			CaptureSessionID: captureID, AccountID: accountID,
		}); err != nil {
			return err
		}
		return enqueue(ctx, tx, TranscriptRecoveryArgs{CaptureSessionID: captureID})
	})
}

// dueWait turns a due-time query into the next step's wait.
func dueWait(seconds float64) time.Duration {
	if math.IsInf(seconds, 1) || math.IsNaN(seconds) {
		return JobDone
	}
	return max(time.Duration(seconds*float64(time.Second)), jobRecheckWait)
}

// voiceJobArgs names its kind and its voice queue.
type voiceJobArgs interface {
	river.JobArgs
	river.JobArgsWithInsertOpts
}

// stepWorker runs one step of a voice job per River attempt. Failures are
// logged and retried by the step's own schedule, so River never discards the
// work of a key that still owes it.
type stepWorker[T river.JobArgs] struct {
	river.WorkerDefaults[T]
	step    func(context.Context, T) (time.Duration, error)
	timeout time.Duration
	// version reads the job row's version when the step starts.
	version func(context.Context, int64) (string, error)
	// finish completes the job unless its row changed since version, which
	// means a wake landed while the step ran.
	finish func(context.Context, *river.Job[T], string) (bool, error)
	logger *slog.Logger
}

func (w *stepWorker[T]) Timeout(*river.Job[T]) time.Duration { return w.timeout }

func (w *stepWorker[T]) Work(ctx context.Context, job *river.Job[T]) error {
	version, err := w.version(ctx, job.ID)
	if err != nil {
		w.logger.ErrorContext(ctx, "read Voice job", "kind", job.Kind, "error", err)
		return river.JobSnooze(jobErrorWait)
	}
	next, err := w.step(ctx, job.Args)
	if err != nil && !errors.Is(err, context.Canceled) {
		w.logger.ErrorContext(ctx, "process Voice work", "kind", job.Kind, "error", err)
	}
	if err != nil && next >= 0 {
		next = max(next, jobErrorWait)
	}
	if next < 0 {
		done, finishErr := w.finish(ctx, job, version)
		switch {
		case finishErr != nil:
			w.logger.ErrorContext(ctx, "complete Voice job", "kind", job.Kind, "error", finishErr)
			next = jobErrorWait
		case done:
			return nil
		default:
			// The wake's commit may hold work this step did not see.
			next = jobRecheckWait
		}
	}
	return river.JobSnooze(next)
}

// A wake that finds its job running only locks and rewrites the job row
// (River's unique insert updates the duplicate it finds), so its commit
// changes the row's xmin. Completion locks the row and completes the job in
// one transaction only while xmin is unchanged: a wake that committed first
// reruns the step, and a wake that commits after the completion no longer
// finds a running duplicate and inserts a new job.
func jobRowVersion(pool *pgxpool.Pool) func(context.Context, int64) (string, error) {
	return func(ctx context.Context, id int64) (string, error) {
		var version string
		err := pool.QueryRow(ctx, `SELECT xmin::text FROM river_job WHERE id=$1`, id).Scan(&version)
		return version, err
	}
}

func finishUnlessWoken[T river.JobArgs](pool *pgxpool.Pool) func(context.Context, *river.Job[T], string) (bool, error) {
	return func(ctx context.Context, job *river.Job[T], version string) (bool, error) {
		done := false
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			var current string
			if err := tx.QueryRow(ctx, `SELECT xmin::text FROM river_job WHERE id=$1 FOR UPDATE`, job.ID).Scan(&current); err != nil {
				return err
			}
			if current != version {
				return nil
			}
			if _, err := river.JobCompleteTx[*riverpgxv5.Driver](ctx, tx, job); err != nil {
				return err
			}
			done = true
			return nil
		})
		return done, err
	}
}

func addStepWorker[T voiceJobArgs](workers *river.Workers, queues map[string]river.QueueConfig, pool *pgxpool.Pool, logger *slog.Logger, timeout time.Duration, step func(context.Context, T) (time.Duration, error)) {
	var zero T
	queue := zero.InsertOpts().Queue
	queues[queue] = voiceQueues[queue]
	river.AddWorker[T](workers, &stepWorker[T]{
		step: step, timeout: timeout, version: jobRowVersion(pool), finish: finishUnlessWoken[T](pool),
		logger: logger,
	})
}

// AddWorkers registers the voice jobs this service can work: reconciliation
// and stop need the LiveKit provider, materialization the Document service and
// materializer, recovery the archive transcriber, cleanup a staging store.
// complete works a finalized Capture's completion; nil leaves it unregistered.
// Each queue a registered job runs on is added to queues.
func (s *Service) AddWorkers(workers *river.Workers, queues map[string]river.QueueConfig, logger *slog.Logger, complete func(context.Context, string) (time.Duration, error)) {
	if s.provider != nil {
		addStepWorker(workers, queues, s.pool, logger, time.Minute, func(ctx context.Context, args VoiceSessionReconcileArgs) (time.Duration, error) {
			return s.reconcileSessionStep(ctx, args.VoiceSessionID)
		})
		addStepWorker(workers, queues, s.pool, logger, 2*time.Minute, func(ctx context.Context, args CaptureReconcileArgs) (time.Duration, error) {
			return s.reconcileCaptureStep(ctx, args.CaptureSessionID)
		})
		addStepWorker(workers, queues, s.pool, logger, 2*voiceMediaStopRecoveryDelay, func(ctx context.Context, args CaptureStopArgs) (time.Duration, error) {
			return s.stopCaptureStep(ctx, args.CaptureSessionID)
		})
	}
	if s.documents != nil && s.materializer != nil {
		addStepWorker(workers, queues, s.pool, logger, materializationTimeout, func(ctx context.Context, args CaptureMaterializeArgs) (time.Duration, error) {
			return s.materializeStep(ctx, args.CaptureSessionID)
		})
	}
	if s.recoversTranscripts() {
		addStepWorker(workers, queues, s.pool, logger, noJobTimeout, func(ctx context.Context, args TranscriptRecoveryArgs) (time.Duration, error) {
			return s.recoverTranscriptStep(ctx, args.CaptureSessionID)
		})
	}
	if _, ok := s.materializer.(stagingCleaner); ok {
		addStepWorker(workers, queues, s.pool, logger, 5*time.Minute, func(ctx context.Context, args StagingCleanupArgs) (time.Duration, error) {
			return s.cleanStagingStep(ctx, args.CaptureSessionID)
		})
	}
	if complete != nil {
		addStepWorker(workers, queues, s.pool, logger, 5*time.Minute, func(ctx context.Context, args CaptureCompletionArgs) (time.Duration, error) {
			return complete(ctx, args.CaptureSessionID)
		})
	}
}

// recoversTranscripts reports whether archive transcript recovery has both its
// audio source and its transcriber.
func (s *Service) recoversTranscripts() bool {
	_, ok := s.materializer.(recoveryAudioProvider)
	return ok && s.archiveASR != nil
}

// ResumeJobs prepares the voice jobs before TeamHub's River client starts.
// One TeamHub runs per database, so a voice job still marked running belonged
// to a process that stopped; it becomes available again at once instead of
// after River's rescue horizon. Every voice session and Capture that still
// owes work then gets its job, so a restart continues from the rows.
func ResumeJobs(ctx context.Context, pool *pgxpool.Pool) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE river_job SET state='available'
			WHERE queue IN ($1,$2,$3) AND state='running'`, QueueVoice, QueueVoiceMedia, QueueVoiceRecovery); err != nil {
			return err
		}
		work, err := store.New(tx).ListUnfinishedVoiceWork(ctx)
		if err != nil {
			return err
		}
		for _, row := range work {
			job, err := unfinishedVoiceJob(row)
			if err != nil {
				return err
			}
			if err := enqueue(ctx, tx, job); err != nil {
				return err
			}
		}
		return nil
	})
}

func unfinishedVoiceJob(row store.ListUnfinishedVoiceWorkRow) (river.JobArgs, error) {
	switch row.Kind {
	case "session":
		return VoiceSessionReconcileArgs{VoiceSessionID: row.ID}, nil
	case "capture":
		return CaptureReconcileArgs{CaptureSessionID: row.ID}, nil
	case "stop":
		return CaptureStopArgs{CaptureSessionID: row.ID}, nil
	case "materialize":
		return CaptureMaterializeArgs{CaptureSessionID: row.ID}, nil
	case "transcript_recovery":
		return TranscriptRecoveryArgs{CaptureSessionID: row.ID}, nil
	case "completion":
		return CaptureCompletionArgs{CaptureSessionID: row.ID}, nil
	case "staging_cleanup":
		return StagingCleanupArgs{CaptureSessionID: row.ID}, nil
	default:
		return nil, fmt.Errorf("unfinished voice work of unknown kind %q", row.Kind)
	}
}

// RunJobStepForTest runs one step of the voice job args names, as its River
// worker would, and returns the step's wait and error.
func (s *Service) RunJobStepForTest(ctx context.Context, args river.JobArgs) (time.Duration, error) {
	switch job := args.(type) {
	case VoiceSessionReconcileArgs:
		return s.reconcileSessionStep(ctx, job.VoiceSessionID)
	case CaptureReconcileArgs:
		return s.reconcileCaptureStep(ctx, job.CaptureSessionID)
	case CaptureStopArgs:
		return s.stopCaptureStep(ctx, job.CaptureSessionID)
	case CaptureMaterializeArgs:
		return s.materializeStep(ctx, job.CaptureSessionID)
	case TranscriptRecoveryArgs:
		return s.recoverTranscriptStep(ctx, job.CaptureSessionID)
	case StagingCleanupArgs:
		return s.cleanStagingStep(ctx, job.CaptureSessionID)
	default:
		return JobDone, fmt.Errorf("voice media has no step for %s", args.Kind())
	}
}
